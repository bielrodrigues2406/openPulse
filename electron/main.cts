import { BrowserWindow, Menu, app, ipcMain, net, protocol, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * openPulse desktop shell. Same web app, plus what a browser tab cannot do:
 * - picks the remembered Polar H10 without the browser's device chooser;
 * - answers Bluetooth pairing prompts for the strap;
 * - can connect on launch;
 * - saves exports straight into Documents/openPulse.
 */

const SCHEME = 'app';
const HOST = 'openpulse';
const DIST = path.join(__dirname, '..', 'dist');
const STATE_FILE = () => path.join(app.getPath('userData'), 'desktop-state.json');
const CHOOSER_TIMEOUT_MS = 20_000;

interface DesktopState {
  deviceId: string | null;
  bounds?: { width: number; height: number; x?: number; y?: number };
}

function readState(): DesktopState {
  try {
    return { deviceId: null, ...(JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) as Partial<DesktopState>) };
  } catch {
    return { deviceId: null };
  }
}

function writeState(patch: Partial<DesktopState>): void {
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch }));
  } catch {
    // Not fatal: the strap will simply be chosen again next time.
  }
}

// A custom secure scheme gives a stable origin (IndexedDB survives updates) and a secure
// context, which Web Bluetooth requires.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Web Bluetooth is off by default in Electron on some platforms (Linux); the app depends on it.
app.commandLine.appendSwitch('enable-features', 'WebBluetooth');

if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

function createWindow(): void {
  const state = readState();
  win = new BrowserWindow({
    width: state.bounds?.width ?? 1440,
    height: state.bounds?.height ?? 920,
    ...(state.bounds?.x !== undefined ? { x: state.bounds.x, y: state.bounds.y } : {}),
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#0b0d0e',
    title: 'openPulse',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep recording timers running when minimised
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => win && writeState({ bounds: win.getBounds() }));

  // Polar strap selection without the chooser: remembered id first, then the first H10 seen.
  let pending: ((id: string) => void) | null = null;
  let chooserTimer: NodeJS.Timeout | null = null;
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pending = callback;
    chooserTimer ??= setTimeout(() => {
      pending?.('');
      pending = null;
      chooserTimer = null;
    }, CHOOSER_TIMEOUT_MS);
    const remembered = readState().deviceId;
    const pick = devices.find((d) => d.deviceId === remembered) ?? devices.find((d) => d.deviceName?.startsWith('Polar H10'));
    if (!pick) return; // keep scanning; the event fires again as devices appear
    writeState({ deviceId: pick.deviceId });
    if (chooserTimer) clearTimeout(chooserTimer);
    chooserTimer = null;
    pending = null;
    callback(pick.deviceId);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const dev = process.env.VITE_DEV_SERVER_URL;
  void win.loadURL(dev ?? `${SCHEME}://${HOST}/index.html`);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const ses = session.defaultSession;
  // H10 pairs with "Just Works": confirm it so Windows does not need a separate pairing step.
  ses.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === 'confirm' || details.pairingKind === 'confirmPin') callback({ confirmed: true });
    else callback({ confirmed: false });
  });

  ses.on('will-download', (_e, item) => {
    const dir = path.join(app.getPath('documents'), 'openPulse');
    fs.mkdirSync(dir, { recursive: true });
    const name = item.getFilename();
    const ext = path.extname(name);
    let target = path.join(dir, name);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      if (state === 'completed') win?.webContents.send('file-saved', target);
    });
  });

  ipcMain.on('ui-ready', (_e, autoConnect: boolean) => {
    // Web Bluetooth needs a user gesture; executeJavaScript(…, true) provides one.
    if (autoConnect) void win?.webContents.executeJavaScript('window.__openPulseAutoConnect && window.__openPulseAutoConnect()', true);
  });
  ipcMain.on('forget-device', () => writeState({ deviceId: null }));
  ipcMain.on('show-file', (_e, file: string) => shell.showItemInFolder(file));

  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
