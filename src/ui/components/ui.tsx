import { useEffect, type ReactNode } from 'react';
import type { ZoneBounds } from '../../domain/athlete/profile';
import { ZONE_FIVE, ZONE_NAME, ZONE_RANGE, type Zone } from '../../domain/workouts/workout';
import { fmt } from '../format';

export const ZONE_LABEL = ZONE_NAME;
export const ZONE_HINT = ZONE_RANGE;
export { ZONE_FIVE };
export const ZONE_COLOR: Record<Zone, string> = { 1: 'var(--z1)', 2: 'var(--z2)', 3: 'var(--z3)' };

export function ZoneChip({ zone, hint = false }: { zone: Zone | null; hint?: boolean }) {
  if (zone === null) return <span className="zone-chip none">sem zona</span>;
  return (
    <span className={`zone-chip z${zone}`}>
      {ZONE_LABEL[zone]}
      {hint && <span style={{ fontWeight: 400, opacity: 0.8 }}>· {ZONE_HINT[zone]}</span>}
    </span>
  );
}

/**
 * Where the current HR sits across the three zones. The scale spans from 30 bpm below VT1 to
 * 20 above VT2 so the marker moves visibly inside every zone.
 */
export function ZoneBar({ bpm, bounds, zone }: { bpm: number | null; bounds: ZoneBounds; zone: Zone | null }) {
  const lo = bounds.vt1 - 30;
  const hi = bounds.vt2 + 20;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const w1 = pct(bounds.vt1);
  const w2 = pct(bounds.vt2) - w1;
  return (
    <div>
      <div className="zonebar" role="img" aria-label={`FC ${bpm ?? '—'} bpm, ${zone ? ZONE_LABEL[zone] : 'sem zona'}`}>
        <span className={`z1 ${zone === 1 ? 'on' : ''}`} style={{ width: `${w1}%` }} />
        <span className={`z2 ${zone === 2 ? 'on' : ''}`} style={{ width: `${w2}%` }} />
        <span className={`z3 ${zone === 3 ? 'on' : ''}`} style={{ flex: 1 }} />
        {bpm !== null && <i style={{ left: `${Math.min(Math.max(pct(bpm), 0), 100)}%` }} />}
      </div>
      <div className="zonebar-labels">
        <b style={{ left: `${w1}%` }}>{bounds.vt1}</b>
        <b style={{ left: `${w1 + w2}%` }}>{bounds.vt2}</b>
      </div>
    </div>
  );
}

export function ZoneDistribution({ seconds, showLegend = true }: { seconds: readonly [number, number, number]; showLegend?: boolean }) {
  const total = seconds[0] + seconds[1] + seconds[2];
  if (total <= 0) return <span className="faint">—</span>;
  const pct = seconds.map((s) => (s / total) * 100);
  return (
    <div>
      <div className="zone-dist" role="img" aria-label={`Leve ${fmt(pct[0])}%, moderada ${fmt(pct[1])}%, intensa ${fmt(pct[2])}%`}>
        {([1, 2, 3] as const).map((z) => pct[z - 1]! > 0 && <span key={z} className={`z${z}`} style={{ width: `${pct[z - 1]}%` }} />)}
      </div>
      {showLegend && (
        <div className="legend" style={{ marginTop: 8 }}>
          {([1, 2, 3] as const).map((z) => (
            <span key={z}>
              <i style={{ background: ZONE_COLOR[z] }} />
              {ZONE_LABEL[z]} <span className="num">{fmt(pct[z - 1])}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Stat(props: { label: ReactNode; value: ReactNode; unit?: string | undefined; note?: ReactNode; color?: string | undefined; estimate?: boolean | undefined; title?: string | undefined }) {
  return (
    <div className="stat" title={props.title}>
      <div className="stat-label">
        {props.label}
        {props.estimate && <span className="est">EST</span>}
      </div>
      <div className="stat-value" style={props.color ? { color: props.color } : undefined}>
        {props.value}
        {props.unit && <small>{props.unit}</small>}
      </div>
      {props.note && <div className="stat-note">{props.note}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>(p: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`segmented ${p.className ?? ''}`} role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === p.value} onClick={() => p.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sheet(p: { title: ReactNode; sub?: ReactNode; children: ReactNode; footer: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!p.onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);
  return (
    <div className="scrim" role="dialog" aria-modal="true">
      <div className="sheet">
        <div className="sheet-head">
          <h2>{p.title}</h2>
          {p.sub && <p className="dim" style={{ marginTop: 4 }}>{p.sub}</p>}
        </div>
        <div className="sheet-body">{p.children}</div>
        <div className="sheet-foot">{p.footer}</div>
      </div>
    </div>
  );
}

export function Section(p: { title: ReactNode; meta?: ReactNode; children: ReactNode; flush?: boolean; actions?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{p.title}</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {p.meta && <span className="meta">{p.meta}</span>}
          {p.actions}
        </div>
      </div>
      <div className="section-body" style={p.flush ? { padding: '10px 0 0' } : undefined}>{p.children}</div>
    </section>
  );
}

export function NumberField(p: { label: string; value: number | null; unit?: string; onChange: (v: number | null) => void; placeholder?: string; hint?: ReactNode; step?: number }) {
  return (
    <label className="field">
      <span>{p.label}</span>
      <div className="input-unit">
        <input
          className="input num"
          inputMode="decimal"
          type="number"
          step={p.step ?? 1}
          value={p.value ?? ''}
          placeholder={p.placeholder}
          onChange={(e) => p.onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
        {p.unit && <em>{p.unit}</em>}
      </div>
      {p.hint && <small>{p.hint}</small>}
    </label>
  );
}
