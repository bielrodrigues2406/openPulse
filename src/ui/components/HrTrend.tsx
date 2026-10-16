import type { SessionStore } from '../session-store';
import { niceRange, useCanvasLoop } from './useCanvasLoop';

const WINDOW_S = 600;
export const GUTTER = 40; // px reserved for y-axis labels

export function HrTrend({ store }: { store: SessionStore }) {
  const ref = useCanvasLoop(({ ctx, width, height, color }) => {
    const pts = store.hr;
    const last = pts.at(-1);
    if (!last) return;
    // Window grows from 1 min up to 10 min, then scrolls.
    const t1 = Math.max(last.tS, 60);
    const t0 = Math.max(0, t1 - WINDOW_S);
    const visible = pts.filter((p) => p.tS >= t0);
    const [lo, hi] = niceRange(Math.min(...visible.map((p) => p.bpm)), Math.max(...visible.map((p) => p.bpm)), 20);
    const x = (t: number) => GUTTER + ((t - t0) / (t1 - t0)) * (width - GUTTER);
    const y = (b: number) => height - ((b - lo) / (hi - lo)) * height;

    drawYTicks(ctx, width, color, lo, hi, 10, y);
    ctx.strokeStyle = color('--signal-hr');
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    visible.forEach((p, i) => (i ? ctx.lineTo(x(p.tS), y(p.bpm)) : ctx.moveTo(x(p.tS), y(p.bpm))));
    ctx.stroke();
  });
  return <canvas ref={ref} className="plot" aria-label="Frequência cardíaca, últimos 10 minutos" />;
}

export function drawYTicks(
  ctx: CanvasRenderingContext2D,
  width: number,
  color: (t: string) => string,
  lo: number,
  hi: number,
  step: number,
  y: (v: number) => number,
): void {
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const py = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = color('--grid');
    ctx.beginPath();
    ctx.moveTo(GUTTER, py);
    ctx.lineTo(width, py);
    ctx.stroke();
    ctx.fillStyle = color('--text-faint');
    ctx.fillText(String(v), 0, Math.max(6, Math.min(py, ctx.canvas.clientHeight - 6)));
  }
}
