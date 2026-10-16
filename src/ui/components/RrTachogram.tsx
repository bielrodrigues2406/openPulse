import type { SessionStore } from '../session-store';
import { GUTTER, drawYTicks } from './HrTrend';
import { niceRange, useCanvasLoop } from './useCanvasLoop';

const WINDOW_MS = 120_000;

/** Beat-by-beat RR. Rejected beats are drawn as hollow red marks, not hidden. */
export function RrTachogram({ store }: { store: SessionStore }) {
  const ref = useCanvasLoop(({ ctx, width, height, color }) => {
    const beats = store.rr.window(WINDOW_MS);
    const last = beats.at(-1);
    if (!last) return;
    const t1 = Math.max(last.tMs, WINDOW_MS);
    const t0 = t1 - WINDOW_MS;
    const ok = beats.filter((b) => b.accepted).map((b) => b.rrMs);
    const [lo, hi] = ok.length ? niceRange(Math.min(...ok), Math.max(...ok), 200) : [400, 1200];
    const x = (t: number) => GUTTER + ((t - t0) / WINDOW_MS) * (width - GUTTER);
    const y = (v: number) => height - ((v - lo) / (hi - lo)) * height;

    drawYTicks(ctx, width, color, lo, hi, 100, y);
    ctx.strokeStyle = color('--signal-rr');
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let pen = false;
    for (const b of beats) {
      if (!b.accepted) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(b.tMs), y(b.rrMs));
      else ctx.moveTo(x(b.tMs), y(b.rrMs));
      pen = true;
    }
    ctx.stroke();

    ctx.strokeStyle = color('--danger');
    for (const b of beats) {
      if (b.accepted) continue;
      const cy = Math.min(Math.max(y(b.rrMs), 4), height - 4);
      ctx.beginPath();
      ctx.arc(x(b.tMs), cy, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  return <canvas ref={ref} className="plot" aria-label="Intervalos R-R, últimos 2 minutos" />;
}
