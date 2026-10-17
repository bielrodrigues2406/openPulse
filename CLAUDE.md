# openPulse — notes for agents

- `npm test` and `npm run typecheck` must pass before committing. TS is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`.
- Layers: `src/domain` is pure (no DOM, no React, no timers); `src/app` owns runtime state (LiveSession, MorningTest, SensorHub, Cues); `src/adapters` talks to BLE/IndexedDB; `src/ui` renders. UI never mutates domain data directly — it goes through `AppData` or `LiveSession`.
- Anything parsed from BLE throws `RangeError` on malformed input rather than guessing. PMD frame type decides sample width: 0x00/0x01/0x02 = 8/16/24-bit, bit 7 = delta-compressed.
- BLE order matters on Windows: subscribe HR first; start PMD only after the first HR packet; a link drop right after a PMD request disables PMD for the session and reconnects HR-only.
- Session times are wall-clock offsets (ms) from `startedAtIso`; recording happens in `segments`. Gaps are real: RR flags `gapBefore`, DFA/inertial trackers restart at each segment (`fromMs`), RMSSD skips pairs across a gap.
- Storage schema changes bump `SESSION_SCHEMA_VERSION` and extend `upgradeRecord`; never rewrite old records in place.
- High-rate data never goes through React state; canvases read `LiveSession` buffers in `requestAnimationFrame`.
- DSP worker messages carry a generation (`gen`); replies from an old segment are dropped.
- UI: dark instrument panel, IBM Plex Sans/Mono (bundled, offline), hairline structure. One colour per signal (ECG green, HR off-white, R-R slate, α1 lilac, breathing sky, cadence pink); zone colours (green/amber/coral) only for zones. No gradients, glows, emoji or decorative cards.
- Estimates (VT1/VT2 lines, zones from max HR, respiration, cadence, kcal) are labelled as estimates in the UI.
- Desktop shell (`electron/*.cts`) must keep `enable-features=WebBluetooth`, the `select-bluetooth-device` handler and the pairing handler; the renderer is the same build as the web app (`base: './'`, served from `app://openpulse`).
- On Windows the desktop app uses native BLE: `electron/native-ble.cts` (noble WinRT, thin transport, opens by address, pairs in code) + `electron/windows-bt.cts` (PowerShell/WinRT: list/unpair paired straps, PC Bluetooth report judged by `src/app/pc-bluetooth.ts`). Policy (HR first, ECG after first beat, auto-repair of a stale pairing once per connection) lives in `src/adapters/native-h10.adapter.ts`, tested with a fake transport. Web Bluetooth stays the path for the browser and non-Windows desktop.
