import { DFA_WINDOW_MS, VT1_ALPHA1, VT2_ALPHA1 } from '../../domain/physiology/dfa-alpha1';
import type { SessionStore } from '../session-store';
import { GUTTER } from './HrTrend';
import { useCanvasLoop } from './useCanvasLoop';

const LO = 0.2;
const HI = 1.6;
const MIN_SPAN_S = 600;

/** α1 over the whole session with the population VT1/VT2 lines. Withheld windows show as red ticks on the baseline. */
export function DfaTrack({ store }: { store: SessionStore }) {
  const ref = useCanvasLoop(({ ctx, width, height, color }) => {
    const plotW = width - GUTTER;
    const y = (a: number) => height - ((a - LO) / (HI - LO)) * height;
    const pts = store.dfa;
    const t1 = Math.max(pts.at(-1)?.tS ?? 0, MIN_SPAN_S);
    const x = (t: number) => GUTTER + (t / t1) * plotW;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    // Zone between the two thresholds, then the threshold lines with labels.
    ctx.fillStyle = color('--band');
    ctx.fillRect(GUTTER, y(VT1_ALPHA1), plotW, y(VT2_ALPHA1) - y(VT1_ALPHA1));
    for (const [a, label] of [[1.0, '1,00'], [VT1_ALPHA1, '0,75'], [VT2_ALPHA1, '0,50']] as const) {
      const py = Math.round(y(a)) + 0.5;
      ctx.strokeStyle = a === 1 ? color('--grid') : color('--text-faint');
      ctx.setLineDash(a === 1 ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(GUTTER, py);
      ctx.lineTo(width, py);
      ctx.stroke();
      ctx.fillStyle = color('--text-faint');
      ctx.fillText(label, 0, py);
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'right';
    ctx.fillText('VT1 est.', width - 4, y(VT1_ALPHA1) - 9);
    ctx.fillText('VT2 est.', width - 4, y(VT2_ALPHA1) + 9);
    ctx.textAlign = 'left';

    if (pts.length === 0) {
      const beatS = (store.rr.all().at(-1)?.tMs ?? 0) / 1000;
      const remaining = Math.max(0, Math.ceil(DFA_WINDOW_MS / 1000 - beatS));
      ctx.fillStyle = color('--text-dim');
      ctx.textAlign = 'center';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(beatS > 0 ? `α1 em ${remaining} s — precisa de 120 s de batimentos` : 'α1 aparece após 120 s de batimentos', GUTTER + plotW / 2, height / 2 - 30);
      ctx.textAlign = 'left';
      return;
    }

    ctx.strokeStyle = color('--signal-dfa');
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (p.alpha1 === null) {
        pen = false;
        continue;
      }
      const py = y(Math.min(Math.max(p.alpha1, LO), HI));
      if (pen) ctx.lineTo(x(p.tS), py);
      else ctx.moveTo(x(p.tS), py);
      pen = true;
    }
    ctx.stroke();

    ctx.strokeStyle = color('--danger');
    ctx.lineWidth = 1.5;
    for (const p of pts) {
      if (p.alpha1 !== null) continue;
      ctx.beginPath();
      ctx.moveTo(x(p.tS), height - 6);
      ctx.lineTo(x(p.tS), height);
      ctx.stroke();
    }
  });
  return <canvas ref={ref} className="plot" aria-label="DFA alfa-1 ao longo da sessão" />;
}
