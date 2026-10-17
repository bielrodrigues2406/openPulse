import { type SessionRecord, summarize } from './recorded-session';

/**
 * Open export formats. CSV uses '.' decimals and ',' separators (RFC 4180) so it loads
 * unchanged in Python/R/Kubios; spreadsheets in pt-BR can import with "separator: comma".
 */

export function rrToCsv(s: SessionRecord): string {
  const rows = s.rr.map((b) => `${fixed(b.tMs, 1)},${fixed(b.rrMs, 3)},${b.accepted ? 1 : 0}`);
  return ['t_ms,rr_ms,accepted', ...rows].join('\n') + '\n';
}

export function hrToCsv(s: SessionRecord): string {
  return ['t_s,bpm', ...s.hr.map((p) => `${fixed(p.tS, 3)},${p.bpm}`)].join('\n') + '\n';
}

/** Time comes from the segment each sample belongs to, so gaps stay visible in t_s. */
export function ecgToCsv(s: SessionRecord, ecgUv: Int32Array): string {
  if (ecgUv.length !== s.ecgSampleCount) {
    throw new RangeError(`ECG has ${ecgUv.length} samples, record says ${s.ecgSampleCount}`);
  }
  const lines = new Array<string>(ecgUv.length + 1);
  lines[0] = 't_s,ecg_uv';
  let i = 0;
  for (const seg of s.ecgSegments) {
    for (let k = 0; k < seg.samples && i < ecgUv.length; k++, i++) {
      lines[i + 1] = `${fixed(seg.startMs / 1000 + k / s.ecgHz, 4)},${ecgUv[i]}`;
    }
  }
  return lines.slice(0, i + 1).join('\n') + '\n';
}

export function inertialToCsv(s: SessionRecord): string {
  const v = (n: number | null, d: number) => (n === null ? '' : fixed(n, d));
  const rows = s.inertial.map(
    (p) => `${fixed(p.tS, 1)},${v(p.breathsPerMin, 2)},${p.breathSource ?? ''},${fixed(p.breathConfidence, 2)},${v(p.rpm, 1)},${fixed(p.rpmConfidence, 2)},${v(p.swayMg, 1)}`,
  );
  return ['t_s,breaths_per_min,breath_source,breath_confidence,rpm,rpm_confidence,sway_mg', ...rows].join('\n') + '\n';
}

export function dfaToCsv(s: SessionRecord): string {
  const rows = s.dfa.map((p) =>
    `${fixed(p.tS, 1)},${p.alpha1 === null ? '' : fixed(p.alpha1, 4)},${fixed(p.artifactPct, 2)},${p.beats},${p.alpha1 === null ? p.reason : ''}`,
  );
  return ['t_s,alpha1,artifact_pct,beats,invalid_reason', ...rows].join('\n') + '\n';
}

/** Full record plus derived summary. ECG is omitted; it has its own CSV. */
export function sessionToJson(s: SessionRecord): string {
  return JSON.stringify({ ...s, summary: summarize(s) }, null, 2);
}

/** Filesystem-safe stem, e.g. "openpulse-2026-10-16-1830". Local time, as the user sees it. */
export function fileStem(s: SessionRecord): string {
  const d = new Date(s.startedAtIso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `openpulse-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function fixed(n: number, digits: number): string {
  return Number(n.toFixed(digits)).toString();
}
