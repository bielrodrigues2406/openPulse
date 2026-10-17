import type { Segment } from '../../domain/session/recorded-session';
import type { Phase, Zone } from '../../domain/workouts/workout';
import { activeToWallMs } from '../../domain/session/fit-encoder';
import { useCanvasLoop, type Frame } from './useCanvasLoop';

export interface TimePoint {
  readonly t: number; // seconds
  readonly v: number | null; // null = break the line
}

export interface Series {
  readonly points: () => readonly TimePoint[];
  readonly color: string; // css colour or --token
  readonly width?: number;
  readonly dots?: boolean;
  /** Per-point colour (e.g. by HR zone); overrides color. */
  readonly colorOf?: (v: number) => string;
  readonly dashed?: boolean;
}

export interface Reference {
  readonly y: number;
  readonly label: string;
}

export interface TimelineProps {
  readonly series: readonly Series[];
  /** Visible x range in seconds. */
  readonly x: () => readonly [number, number];
  readonly y: { readonly min: number; readonly max: number; readonly step: number; readonly fmt?: (v: number) => string } | 'auto';
  /** With y = 'auto': the smallest span to show (bpm charts look broken at ±0.5). */
  readonly minSpan?: number | undefined;
  readonly refs?: readonly Reference[] | undefined;
  readonly band?: { readonly from: number; readonly to: number; readonly color: string } | undefined;
  readonly phases?: (() => { readonly phases: readonly Phase[]; readonly segments: readonly Segment[] }) | undefined;
  readonly segments?: (() => readonly Segment[]) | undefined;
  readonly live?: boolean | undefined;
  readonly version?: unknown | undefined;
  readonly height?: number | undefined;
  readonly empty?: string | undefined;
  readonly label: string;
  /** Custom x ticks (e.g. dates); default is elapsed time. */
  readonly xTicks?: ((x0: number, x1: number) => readonly { readonly t: number; readonly label: string }[]) | undefined;
}

const GUTTER = 38;
const PHASE_STRIP = 5;
const ZONE_TOKEN: Record<Zone, string> = { 1: '--z1', 2: '--z2', 3: '--z3' };

/** One time-series canvas for live and stored data: grid, references, phases, gaps, lines. */
export function Timeline(p: TimelineProps) {
  const ref = useCanvasLoop((f) => paint(f, p), { live: p.live ?? true, version: p.version, fps: 4 });
  return (
    <div className="canvas-box" style={{ height: p.height ?? 180 }}>
      <canvas ref={ref} aria-label={p.label} />
    </div>
  );
}

function paint({ ctx, width, height, color }: Frame, p: TimelineProps): void {
  const [x0, x1] = p.x();
  const top = p.phases ? PHASE_STRIP + 6 : 4;
  const bottom = height - 18;
  const plotW = width - GUTTER;
  const all = p.series.map((s) => s.points());
  let y = p.y;
  if (y === 'auto') {
    // 1st–99th percentile: a single artifact spike must not flatten the whole trace.
    const vals = all.flat().filter((q) => q.t >= x0 && q.t <= x1 && q.v !== null).map((q) => q.v!).sort((a, b) => a - b);
    let lo = vals.length ? vals[Math.floor(vals.length * 0.01)]! : 0;
    let hi = vals.length ? vals[Math.min(vals.length - 1, Math.ceil(vals.length * 0.99) - 1)]! : 1;
    const minSpan = p.minSpan ?? 1;
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const span = hi - lo;
    const step = niceStep(span / 4);
    const nonNegative = vals.length > 0 && vals[0]! >= 0;
    const yMin = Math.floor((lo - span * 0.1) / step) * step;
    y = { min: nonNegative ? Math.max(0, yMin) : yMin, max: Math.ceil((hi + span * 0.1) / step) * step, step };
  }
  const { min, max, step } = y;
  const fy = y.fmt ?? ((v: number) => String(Math.round(v * 100) / 100).replace('.', ','));
  const X = (t: number) => GUTTER + ((t - x0) / Math.max(x1 - x0, 1e-6)) * plotW;
  const Y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);

  ctx.font = '10.5px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  if (p.band) {
    ctx.fillStyle = color(p.band.color);
    const a = Y(Math.min(p.band.to, max));
    const b = Y(Math.max(p.band.from, min));
    ctx.fillRect(GUTTER, a, plotW, b - a);
  }

  // Horizontal grid + y labels
  ctx.lineWidth = 1;
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    const py = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = color('--grid');
    ctx.beginPath();
    ctx.moveTo(GUTTER, py);
    ctx.lineTo(width, py);
    ctx.stroke();
    ctx.fillStyle = color('--text-faint');
    ctx.fillText(fy(v), 0, py);
  }

  // X labels
  const ticks = p.xTicks ? p.xTicks(x0, x1) : defaultTicks(x0, x1);
  ctx.textAlign = 'center';
  ctx.fillStyle = color('--text-faint');
  for (const tk of ticks) {
    const px = X(tk.t);
    if (px < GUTTER + 14 || px > width - 14) continue;
    ctx.fillText(tk.label, px, height - 7);
  }
  ctx.textAlign = 'left';

  // Gaps between segments (recording paused)
  const segs = p.phases?.().segments ?? p.segments?.() ?? null;
  if (segs && segs.length > 1) {
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let i = 1; i < segs.length; i++) {
      const a = X(segs[i - 1]!.endMs / 1000);
      const b = X(segs[i]!.startMs / 1000);
      if (b > GUTTER && a < width) ctx.fillRect(Math.max(a, GUTTER), top, Math.min(b, width) - Math.max(a, GUTTER), bottom - top);
    }
  }

  // Phase strip coloured by target zone; phases not reached yet are projected from now on.
  if (p.phases) {
    const { phases, segments } = p.phases();
    const activeTotal = segments.reduce((s, g) => s + g.endMs - g.startMs, 0) / 1000;
    const lastEnd = (segments.at(-1)?.endMs ?? 0) / 1000;
    const wallAt = (activeS: number) => {
      const w = activeToWallMs(segments, activeS);
      return w !== null ? w / 1000 : lastEnd + (activeS - activeTotal);
    };
    let acc = 0;
    for (const ph of phases) {
      const pa = Math.max(X(wallAt(acc)), GUTTER);
      acc += ph.durationS;
      const pb = Math.min(X(wallAt(acc)), width);
      if (pb <= pa) continue;
      ctx.fillStyle = ph.target.kind === 'zone' ? color(ZONE_TOKEN[ph.target.zone]) : ph.target.kind === 'alpha1' ? color('--sig-dfa') : color('--line-strong');
      ctx.globalAlpha = 0.85;
      ctx.fillRect(pa, 1, Math.max(0, pb - pa - 2), PHASE_STRIP);
      ctx.globalAlpha = 1;
    }
  }

  // Reference lines
  for (const r of p.refs ?? []) {
    if (r.y < min || r.y > max) continue;
    const py = Math.round(Y(r.y)) + 0.5;
    ctx.strokeStyle = color('--text-faint');
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(GUTTER, py);
    ctx.lineTo(width, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'right';
    ctx.fillText(r.label, width - 2, py - 8);
    ctx.textAlign = 'left';
  }

  let drew = false;
  p.series.forEach((s, si) => {
    const pts = all[si]!;
    ctx.lineWidth = s.width ?? 1.6;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dashed ? [4, 4] : []);
    if (s.dots) {
      for (const q of pts) {
        if (q.v === null || q.t < x0 || q.t > x1) continue;
        ctx.fillStyle = color(s.colorOf ? s.colorOf(q.v) : s.color);
        ctx.beginPath();
        ctx.arc(X(q.t), Math.min(Math.max(Y(q.v), top), bottom), 2.4, 0, Math.PI * 2);
        ctx.fill();
        drew = true;
      }
      return;
    }
    // One path per run of equal colour: a 2 h session is thousands of points.
    let prev: TimePoint | null = null;
    let pathColor: string | null = null;
    const flush = () => {
      if (pathColor !== null) ctx.stroke();
      pathColor = null;
    };
    for (const q of pts) {
      if (q.t < x0 - 30 || q.t > x1 + 30 || q.v === null) {
        prev = null;
        continue;
      }
      if (prev && prev.v !== null) {
        const c = color(s.colorOf ? s.colorOf(q.v) : s.color);
        if (c !== pathColor) {
          flush();
          ctx.strokeStyle = c;
          ctx.beginPath();
          ctx.moveTo(X(prev.t), Y(clamp(prev.v, min, max)));
          pathColor = c;
        }
        ctx.lineTo(X(q.t), Y(clamp(q.v, min, max)));
        drew = true;
      } else {
        flush();
      }
      prev = q;
    }
    flush();
  });
  ctx.setLineDash([]);

  if (!drew && p.empty) {
    ctx.fillStyle = color('--text-faint');
    ctx.font = '13px "IBM Plex Sans", system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(p.empty, GUTTER + plotW / 2, (top + bottom) / 2);
    ctx.textAlign = 'left';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

function defaultTicks(x0: number, x1: number): { t: number; label: string }[] {
  const step = niceTimeStep(x1 - x0);
  const out: { t: number; label: string }[] = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) out.push({ t, label: timeLabel(t, step < 60) });
  return out;
}

function niceTimeStep(spanS: number): number {
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => spanS / s <= 7) ?? 7200;
}

function timeLabel(t: number, seconds = false): string {
  if (seconds) return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  const m = Math.floor(t / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}` : `${m}′`;
}
