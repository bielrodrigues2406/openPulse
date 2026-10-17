/** pt-BR display helpers. Data stays in SI units; this is the only place that formats. */

export function fmt(v: number | null | undefined, digits = 0, fallback = '—'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return fallback;
  return v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 1:05:09 / 5:09 */
export function clock(totalS: number): string {
  const t = Math.max(0, Math.floor(totalS));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "1 h 05" / "45 min" / "40 s" */
export function duration(totalS: number): string {
  const t = Math.round(totalS);
  if (t < 60) return `${t} s`;
  const h = Math.floor(t / 3600);
  const m = Math.round((t % 3600) / 60);
  if (!h) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '');
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
}

export function timeOnly(iso: string | number): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function monthTitle(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }).replace('.', '');
}

export const SPORT_LABEL = { 'bike-indoor': 'Bike indoor', run: 'Corrida', other: 'Outro' } as const;

export const KIND_LABEL = {
  free: 'Livre',
  endurance: 'Resistência',
  intervals: 'Intervalado',
  threshold: 'Limiar',
  ramp: 'Teste',
  recovery: 'Regenerativo',
} as const;
