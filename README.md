# openPulse

Training cockpit for the Polar H10 chest strap. Live ECG, beat-by-beat R-R, DFA α1 with automatic
HRVT1/HRVT2 from a ramp, polarized zones, respiration and cadence from the chest accelerometer,
structured workouts with voice cues, a weekly plan, history, trends and a morning readiness test.
Everything stays on your device.

> Interface in Brazilian Portuguese. Physiological estimates (thresholds, zones from max HR,
> respiration, cadence, calories) are labelled as estimates in the app; they are not medical advice.

## Install

### Desktop app (Windows) — recommended

No browser, no device chooser: the app remembers your strap, answers the Bluetooth pairing prompt
itself and can connect on launch. Exports go straight to `Documents\openPulse`.

```sh
npm install
npm run desktop:dist      # → release/openPulse Setup x.y.z.exe and a portable .exe
```

Run without packaging: `npm run desktop`.

### Web app

```sh
npm install
npm run dev               # open in Chrome or Edge
```

Built (`npm run build`) and served over HTTPS or localhost, it is installable (PWA) and works
offline. Web Bluetooth exists only in Chromium browsers; Safari/iOS cannot connect to the strap.
Data is stored per origin: moving from the browser to the desktop app goes through
**Perfil → Exportar backup / Importar backup**.

### First connection on Windows

If the strap connects but drops right away, Windows wants to pair it. The desktop app confirms the
pairing on its own; in a browser, accept the "Adicionar um dispositivo" notification once.
The strap allows two connections at a time; close Polar Flow (or turn off the phone's Bluetooth)
if it is connected elsewhere.

## What it does

| Area | Details |
|---|---|
| **Treino** | Free ride or structured workout. Phases with targets by zone or α1, spoken cues, 3-2-1 beeps, repeat cues (ramp: "suba um nível" every minute), off-target alerts after 30 s. Live HR with current zone and zone bar, α1, RMSSD, artifacts, respiration, cadence, kcal, ECG strip, charts. Focus mode (`F`) with huge numbers; `Espaço` marks a lap, `P` pauses. |
| **Recording** | Saved every 10 s. If the strap goes silent for 6 s the workout pauses and resumes by itself when data returns; gaps are real gaps (DFA restarts after them). An interrupted workout (app closed, crash) can be resumed or finished from the Treino screen. |
| **Limiares** | After a "Rampa DFA" the app regresses α1 on HR over the falling part of the curve and solves for 0.75 (HRVT1) and 0.50 (HRVT2), with R². One click updates your zones. "Rampa DFA · ergométrica" is made for bikes with a resistance knob and no power: fixed 90 rpm, the same knob turn every 2 min, a lap per step, cadence warnings, and a cue once α1 has stayed below 0.50 for 2 min. |
| **Zonas** | Polarized 3-zone model anchored on HRVT1/HRVT2, named *Leve / Moderada / Intensa* (≈ Z1–Z2 / Z3–Z4 / Z5 on the 5-zone %HRmax scale) so they never clash with Polar/Garmin numbering; falls back to 77%/89% of max HR (measured, or 208 − 0.7 × age) and says so. |
| **Semana** | Recurring weekly structure (presets: 2 sessions long + quality, 3 sessions, polarized 80/20), planned vs done, volume, load (Lucia TRIMP) and time per zone. |
| **Histórico** | Per session: stats, HR coloured by zone, α1, respiration/cadence, phases & laps, HR recovery 60 s after each hard interval, HR drift, thresholds, notes and RPE. |
| **Evolução** | HRVT1/HRVT2 over time, weekly volume per zone, fitness/fatigue (42/7-day EWMA of TRIMP), morning ln RMSSD, HR drift on long rides. |
| **Teste matinal** | 90 s lying + 90 s standing. ln RMSSD vs your own 7-day baseline (after 3 tests). |
| **Export** | FIT (records, laps, session, every R-R in HRV messages — Strava, Garmin Connect, TrainingPeaks, Intervals.icu; Intervals.icu runs its own DFA α1 on it), CSV (R-R, HR, α1, respiration/cadence, ECG) and JSON. |

## Signal processing

- **R-R**: 0x2A37 at 1/1024 s. Beats outside 250–2000 ms or >20% off the median of the last 5 are
  flagged, not dropped; five consistent "outliers" in a row are accepted as a real change of rhythm.
- **DFA α1**: Peng et al., scales 4–16 beats, 120 s window every 5 s, in a Web Worker. Rejected beats
  are interpolated; windows with >5% artifacts, <64 beats or no variability are withheld.
- **ECG/ACC**: PMD service, frame type decides sample width (8/16/24-bit, delta-compressed).
  Started only after the first HR packet; if it drops the link, the session continues HR-only.
- **Respiration**: dominant 0.1–1.0 Hz oscillation of the chest accelerometer (no axis assumed)
  fused with respiratory sinus arrhythmia from R-R, weighted by spectral prominence.
- **Cadence**: the trunk sways once per crank revolution and bounces once per pedal stroke; the
  strongest peak is resolved against its half/double on any axis. Trunk sway = RMS of that axis.

## Development

```sh
npm test            # 120+ tests: parsers, DSP, storage, FIT (validated by an independent decoder), live session
npm run typecheck
```

```
src/domain/      pure logic, no DOM: physiology, workouts, athlete, session, analysis
src/app/         live session, morning test, sensor hub, audio cues
src/adapters/    Web Bluetooth H10, simulator, IndexedDB storage
src/workers/     DFA + inertial DSP worker
src/ui/          React screens, canvas charts
electron/        desktop shell (main + preload)
```

The simulator (Perfil → Fonte de dados) is deterministic: a 15-minute ramp where α1 falls through
0.75, breathing rises 14 → 36 /min and cadence wanders around 90 rpm.
