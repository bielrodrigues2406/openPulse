import { ECG_HZ, type LiveSession } from '../../app/live-session';
import { useCanvasLoop } from './useCanvasLoop';

const SECONDS = 6;
const UV_RANGE = 1500; // ±1.5 mV visible

/** Sweep-style ECG: fixed paper, the write head moves left to right and erases ahead of itself. */
export function LiveEcgStrip({ live }: { live: LiveSession }) {
  const ref = useCanvasLoop(({ ctx, width, height, color }) => {
    const n = ECG_HZ * SECONDS;
    const xPer = width / n;

    // 0.2 s major grid, like ECG paper at 25 mm/s.
    ctx.strokeStyle = color('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = 0; s <= SECONDS * 5; s++) {
      const x = Math.round((s * width) / (SECONDS * 5)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let mv = -1.5; mv <= 1.5; mv += 0.5) {
      const y = Math.round(height / 2 - (mv * 1000 * height) / (2 * UV_RANGE)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    const written = live.ecgWritten;
    if (written === 0) {
      ctx.fillStyle = color('--text-faint');
      ctx.font = '13px "IBM Plex Sans", system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('ECG aparece após o primeiro batimento, se a cinta permitir', width / 2, height / 2 + 4);
      ctx.textAlign = 'left';
      return;
    }
    const head = written % n;
    const cap = live.ecg.length;
    const gap = 6; // columns erased ahead of the write head

    ctx.strokeStyle = color('--sig-ecg');
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      // newest sample index that lands on column i
      const abs = written - 1 - (((written - 1 - i) % n) + n) % n;
      if (abs < 0 || (i - head + n) % n < gap) {
        pen = false;
        continue;
      }
      const v = live.ecg[abs % cap]!;
      const y = height / 2 - (v * height) / (2 * UV_RANGE);
      if (pen) ctx.lineTo(i * xPer, y);
      else ctx.moveTo(i * xPer, y);
      pen = true;
    }
    ctx.stroke();
  });
  return (
    <div className="canvas-box">
      <canvas ref={ref} aria-label="ECG ao vivo, últimos 6 segundos" />
    </div>
  );
}
