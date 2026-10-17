import type { ReactNode } from 'react';

export interface Bar {
  readonly label: string;
  /** Stacked from bottom. */
  readonly parts: readonly { readonly value: number; readonly color: string }[];
  readonly title?: string;
  readonly highlight?: boolean;
}

/** Small stacked bar chart in HTML (crisp at any size, accessible titles). */
export function Bars({ bars, height = 160, unit, empty }: { bars: readonly Bar[]; height?: number; unit: string; empty?: ReactNode }) {
  const max = Math.max(1, ...bars.map((b) => b.parts.reduce((s, p) => s + p.value, 0)));
  if (bars.every((b) => b.parts.every((p) => p.value === 0))) return <div className="empty" style={{ padding: 24 }}>{empty}</div>;
  return (
    <div className="bars" style={{ height }}>
      {bars.map((b) => {
        const total = b.parts.reduce((s, p) => s + p.value, 0);
        return (
          <div key={b.label} className={`bar${b.highlight ? ' hl' : ''}`} title={b.title ?? `${b.label}: ${Math.round(total)} ${unit}`}>
            <div className="bar-stack" style={{ height: `${(total / max) * 100}%` }}>
              {b.parts.map((p, i) => p.value > 0 && <span key={i} style={{ flexGrow: p.value, background: p.color }} />)}
            </div>
            <div className="bar-label">{b.label}</div>
          </div>
        );
      })}
    </div>
  );
}
