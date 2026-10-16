# openPulse — notes for agents

- `npm test` and `npm run typecheck` must pass before committing. TS is strict with `noUncheckedIndexedAccess`; no `any`.
- `src/domain` stays pure (no DOM, no React). Anything parsed from BLE throws `RangeError` on malformed input rather than guessing.
- PMD frame type decides sample width: 0x00/0x01/0x02 = 8/16/24-bit, bit 7 = delta-compressed. Never assume 16-bit.
- High-rate data never goes through React state; canvases read `SessionStore` buffers in `requestAnimationFrame`.
- UI: dark instrument panel, tabular mono numerals, one accent per signal (HR amber, ECG green, R-R slate, red only for rejection/error). No gradients, glows, emoji or decorative cards.
- Physiological estimates (VT1/VT2, respiration, cadence) are labelled as estimates in the UI.
