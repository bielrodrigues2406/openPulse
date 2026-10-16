import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PolarSensor, SensorStatus } from '../domain/ports/polar-sensor.port';
import { SimulatedH10Adapter } from '../adapters/simulated-h10.adapter';
import { WebBluetoothH10Adapter, isWebBluetoothAvailable } from '../adapters/web-bluetooth-h10.adapter';
import { IndexedDbSessionRepository } from '../adapters/indexeddb-session.repository';
import { SessionStore, type Readout, type SaveState } from './session-store';
import { SessionHistory } from './components/SessionHistory';
import { LiveEcgStrip } from './components/LiveEcgStrip';
import { HrTrend } from './components/HrTrend';
import { RrTachogram } from './components/RrTachogram';

type Source = 'h10' | 'sim';
type View = 'live' | 'history';

export function CockpitApp() {
  const bleAvailable = isWebBluetoothAvailable();
  const [source, setSource] = useState<Source>(bleAvailable ? 'h10' : 'sim');
  const [view, setView] = useState<View>('live');
  const repo = useMemo(() => new IndexedDbSessionRepository(), []);
  const store = useMemo(() => new SessionStore((record, ecg) => repo.save(record, ecg)), [repo]);
  const sensor = useMemo<PolarSensor>(
    () => (source === 'h10' ? new WebBluetoothH10Adapter() : new SimulatedH10Adapter()),
    [source],
  );
  useEffect(() => {
    store.attach(sensor, source);
    return () => sensor.disconnect();
  }, [store, sensor, source]);

  const r = useSyncExternalStore(store.subscribe, store.getReadout);
  const live = r.status.state === 'streaming';
  const busy = r.status.state === 'connecting';

  return (
    <div className="shell">
      <header className="bar">
        <nav className="brand-nav">
          <span className="brand">openPulse</span>
          <div className="tabs" role="tablist" aria-label="Seção">
            <button role="tab" aria-selected={view === 'live'} onClick={() => setView('live')}>Ao vivo</button>
            <button role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>Sessões</button>
          </div>
        </nav>

        <div className="controls">
          <div className="segmented" role="radiogroup" aria-label="Fonte de dados">
            <button
              role="radio"
              aria-checked={source === 'h10'}
              disabled={live || busy || !bleAvailable}
              title={bleAvailable ? undefined : 'Web Bluetooth requer Chrome ou Edge'}
              onClick={() => setSource('h10')}
            >
              Polar H10
            </button>
            <button role="radio" aria-checked={source === 'sim'} disabled={live || busy} onClick={() => setSource('sim')}>
              Simulador
            </button>
          </div>
          <button
            className={live ? 'btn btn-quiet' : 'btn btn-primary'}
            disabled={busy}
            onClick={() => (live ? sensor.disconnect() : void sensor.connect())}
          >
            {live ? 'Desconectar' : busy ? 'Conectando…' : 'Conectar'}
          </button>
        </div>

        <StatusLine status={r.status} elapsedS={r.elapsedS} contact={r.contact} save={r.save} />
      </header>

      {view === 'history' ? (
        <main className="history-wrap">
          <SessionHistory repo={repo} refreshKey={r.save} />
        </main>
      ) : (
        <>
      <section className="readouts" aria-label="Leituras">
        <Metric label="FC" unit="bpm" value={r.bpm} digits={0} accent="hr" large />
        <Metric label="R-R" unit="ms" value={r.lastRrMs} digits={0} accent="rr" />
        <Metric label="RMSSD 60 s" unit="ms" value={r.rmssdMs} digits={1} />
        <Metric
          label="Artefatos 60 s"
          unit="%"
          value={r.artifactPct}
          digits={1}
          warn={r.artifactPct !== null && r.artifactPct > 5}
          hint="Acima de 5% o DFA α1 deixa de ser confiável"
        />
      </section>

      <main className="tracks">
        <Track title="ECG" meta="130 Hz · 6 s · grade 0,2 s / 0,5 mV" tall>
          {live || r.bpm !== null ? <LiveEcgStrip store={store} /> : <Empty source={source} />}
        </Track>
        <div className="tracks-row">
          <Track title="Frequência cardíaca" meta="bpm · 10 min">
            <HrTrend store={store} />
          </Track>
          <Track title="Tacograma R-R" meta={<>ms · 2 min · <span className="key-reject">○</span> rejeitado</>}>
            <RrTachogram store={store} />
          </Track>
        </div>
      </main>
        </>
      )}
    </div>
  );
}

function Metric(props: {
  label: string;
  unit: string;
  value: number | null;
  digits: number;
  accent?: 'hr' | 'rr';
  large?: boolean;
  warn?: boolean;
  hint?: string;
}) {
  const cls = ['metric', props.large && 'metric-large', props.accent && `accent-${props.accent}`, props.warn && 'is-warn']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} title={props.hint}>
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">
        {props.value === null ? '—' : props.value.toLocaleString('pt-BR', { maximumFractionDigits: props.digits, minimumFractionDigits: props.digits })}
        <span className="metric-unit">{props.unit}</span>
      </div>
    </div>
  );
}

function Track(props: { title: string; meta: ReactNode; tall?: boolean; children: ReactNode }) {
  return (
    <section className={props.tall ? 'track track-tall' : 'track'}>
      <header className="track-head">
        <h2>{props.title}</h2>
        <span className="track-meta">{props.meta}</span>
      </header>
      <div className="track-body">{props.children}</div>
    </section>
  );
}

function StatusLine(props: { status: SensorStatus; elapsedS: Readout['elapsedS']; contact: boolean | null; save: SaveState }) {
  const { status, elapsedS, contact, save } = props;
  let text: string;
  let tone: 'idle' | 'live' | 'warn' | 'error' = 'idle';
  switch (status.state) {
    case 'idle':
      text = 'Desconectado';
      break;
    case 'connecting':
      text = 'Procurando cinta…';
      break;
    case 'streaming':
      tone = contact === false ? 'warn' : 'live';
      text = contact === false ? `${status.deviceName} · sem contato com a pele` : `${status.deviceName} · ${clock(elapsedS)}`;
      break;
    case 'error':
      tone = 'error';
      text = status.message;
      break;
  }
  return (
    <div className={`status status-${tone}`} role="status">
      <span className="status-dot" aria-hidden />
      {text}
      {save.state === 'saved' && <span className="status-save">salvo {new Date(save.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
      {save.state === 'error' && <span className="status-save is-error">falha ao salvar: {save.message}</span>}
    </div>
  );
}

function Empty({ source }: { source: Source }) {
  return (
    <div className="empty">
      {source === 'h10' ? (
        <>
          <p>Umedeça os eletrodos, vista a cinta e clique em <strong>Conectar</strong>.</p>
          <p className="empty-sub">O navegador vai listar as cintas Polar H10 por perto.</p>
        </>
      ) : (
        <>
          <p>Clique em <strong>Conectar</strong> para iniciar o sinal simulado.</p>
          <p className="empty-sub">Mesma semente, mesmo sinal — inclui batimentos ectópicos para testar o filtro.</p>
        </>
      )}
    </div>
  );
}

function clock(s: number): string {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}
