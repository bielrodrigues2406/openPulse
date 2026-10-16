# openPulse

Real-time Web Bluetooth cockpit for the Polar H10 on a stationary bike. Local-first: nothing leaves the browser.

**Status:** stage 2. Live HR, beat-by-beat R-R with artifact gating, RMSSD, a 130 Hz ECG strip,
and local session history with open export.
ECG and 200 Hz accelerometer streams are decoded; DFA α1, respiration and cadence are not built yet.

## Run

```sh
npm install
npm run dev      # open in Chrome or Edge (desktop or Android)
npm test
```

Web Bluetooth only exists in Chromium browsers. Safari, Firefox and iOS cannot connect to the strap;
use **Simulador** there. The simulator is deterministic (same seed, same signal) and injects ~1% ectopic beats.

## What the numbers mean

- **R-R** comes from the standard Heart Rate characteristic (0x2A37) at 1/1024 s resolution.
- A beat is **rejected** if outside 250–2000 ms or more than 20% away from the median of the last 5 accepted beats.
  Rejected beats are shown as red circles on the tachogram, never silently hidden.
- **RMSSD** uses only pairs where both beats were accepted, over the last 60 s.
- **Artifacts** above 5% turn red: that's roughly where DFA α1 stops being trustworthy.

## Sessions and export

Sessions are written to IndexedDB every 30 s while streaming and again on disconnect, so closing the tab
loses at most 30 s. Data never leaves this browser; clearing site data deletes it. From **Sessões**:

| File | Columns |
|---|---|
| `*-rr.csv` | `t_ms,rr_ms,accepted` — every beat, rejected ones flagged `0`, not dropped |
| `*-hr.csv` | `t_s,bpm` |
| `*-ecg.csv` | `t_s,ecg_uv` at 130 Hz |
| `*.json` | full record (schema v1) plus summary; ECG excluded |

CSV uses `.` decimals and `,` separators, so it loads unchanged in Python, R or Kubios.

## Layout

```
src/domain/ports/        sensor contract shared by real and simulated adapters
src/domain/physiology/   pure parsers and HRV math (no DOM, fully tested)
src/domain/session/      session record, summary, CSV/JSON export (pure)
src/adapters/            Web Bluetooth H10, simulator, IndexedDB repository
src/ui/                  React shell; canvases read typed ring buffers per animation frame
tests/                   parser properties and HRV invariants
```
