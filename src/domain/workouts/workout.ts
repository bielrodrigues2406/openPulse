/**
 * Structured workouts. Zones follow the 3-zone polarized model anchored on the two
 * ventilatory thresholds, because that is what DFA α1 estimates:
 *   Leve < VT1 ≤ Moderada < VT2 ≤ Intensa.
 * They are named, not numbered, so they never collide with the 5-zone %HRmax scale athletes
 * already speak (Polar, Garmin): "Z2" there is *Leve* here, "Z3–Z4" is *Moderada*.
 */

export type Sport = 'bike-indoor' | 'run' | 'other';
export type Zone = 1 | 2 | 3;

export type Target =
  | { readonly kind: 'none' }
  | { readonly kind: 'zone'; readonly zone: Zone }
  /** α1 band; null bound = open. "Abaixo de VT1" is { min: 0.75, max: null }. */
  | { readonly kind: 'alpha1'; readonly min: number | null; readonly max: number | null };

export interface RepeatCue {
  readonly everyS: number;
  readonly text: string;
  /** Also mark a lap at each cue (ramp steps). Absent in templates saved before it existed. */
  readonly lap?: boolean;
}

export interface Phase {
  readonly name: string;
  readonly durationS: number;
  readonly target: Target;
  /** Spoken/shown when the phase starts. */
  readonly cue: string;
  readonly repeatCue: RepeatCue | null;
  /** Cadence to hold, rpm; the app warns when the estimate drifts away. Absent = free. */
  readonly cadenceRpm?: number;
}

export const ZONE_NAME: Record<Zone, string> = { 1: 'Leve', 2: 'Moderada', 3: 'Intensa' };
export const ZONE_RANGE: Record<Zone, string> = { 1: 'abaixo de VT1', 2: 'entre VT1 e VT2', 3: 'acima de VT2' };
/** Rough equivalent on the 5-zone %HRmax scale. */
export const ZONE_FIVE: Record<Zone, string> = { 1: 'Z1–Z2', 2: 'Z3–Z4', 3: 'Z5' };

export type WorkoutKind = 'free' | 'endurance' | 'intervals' | 'threshold' | 'ramp' | 'recovery';

export interface WorkoutTemplate {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkoutKind;
  readonly sport: Sport;
  readonly description: string;
  /** Empty = open-ended (free ride). */
  readonly phases: readonly Phase[];
  readonly builtIn: boolean;
}

export const NO_TARGET: Target = { kind: 'none' };

export function phase(name: string, minutes: number, target: Target = NO_TARGET, cue = '', repeatCue: RepeatCue | null = null, cadenceRpm?: number): Phase {
  const p: Phase = { name, durationS: Math.round(minutes * 60), target, cue, repeatCue };
  return cadenceRpm === undefined ? p : { ...p, cadenceRpm };
}

export function repeat(times: number, block: readonly Phase[]): Phase[] {
  const out: Phase[] = [];
  for (let i = 1; i <= times; i++) for (const p of block) out.push({ ...p, name: `${p.name} ${i}/${times}` });
  return out;
}

export function totalDurationS(phases: readonly Phase[]): number {
  return phases.reduce((s, p) => s + p.durationS, 0);
}

export interface PhasePosition {
  readonly index: number;
  readonly phase: Phase;
  readonly phaseElapsedS: number;
  readonly phaseRemainingS: number;
  readonly next: Phase | null;
}

/** Where a structured workout is after `activeS` seconds of recording. null when open-ended or finished. */
export function phaseAt(phases: readonly Phase[], activeS: number): PhasePosition | null {
  let start = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]!;
    if (activeS < start + p.durationS) {
      return { index: i, phase: p, phaseElapsedS: activeS - start, phaseRemainingS: start + p.durationS - activeS, next: phases[i + 1] ?? null };
    }
    start += p.durationS;
  }
  return null;
}

export type TargetState = 'below' | 'in' | 'above' | 'unknown';

/**
 * 'below'/'above' refer to intensity, not to the number: α1 falls as intensity rises,
 * so α1 under its band means the athlete is working *above* the target.
 */
export function evaluateTarget(
  target: Target,
  now: { readonly hr: number | null; readonly alpha1: number | null },
  zoneOf: ((hr: number) => Zone) | null,
): TargetState {
  switch (target.kind) {
    case 'none':
      return 'unknown';
    case 'zone': {
      if (now.hr === null || !zoneOf) return 'unknown';
      const z = zoneOf(now.hr);
      return z < target.zone ? 'below' : z > target.zone ? 'above' : 'in';
    }
    case 'alpha1': {
      if (now.alpha1 === null) return 'unknown';
      if (target.min !== null && now.alpha1 < target.min) return 'above';
      if (target.max !== null && now.alpha1 > target.max) return 'below';
      return 'in';
    }
  }
}

export function describeTarget(t: Target): string {
  switch (t.kind) {
    case 'none':
      return 'Livre';
    case 'zone':
      return `${ZONE_NAME[t.zone]} · ${ZONE_RANGE[t.zone]}`;
    case 'alpha1': {
      const f = (n: number) => n.toFixed(2).replace('.', ',');
      if (t.min !== null && t.max !== null) return `α1 entre ${f(t.min)} e ${f(t.max)}`;
      if (t.min !== null) return `α1 acima de ${f(t.min)}`;
      if (t.max !== null) return `α1 abaixo de ${f(t.max)}`;
      return 'Livre';
    }
  }
}

const Z1: Target = { kind: 'zone', zone: 1 };
const Z2: Target = { kind: 'zone', zone: 2 };
const Z3: Target = { kind: 'zone', zone: 3 };
const BELOW_VT1: Target = { kind: 'alpha1', min: 0.75, max: null };

export const FREE_WORKOUT: WorkoutTemplate = {
  id: 'free',
  name: 'Treino livre',
  kind: 'free',
  sport: 'bike-indoor',
  description: 'Sem estrutura. Grava tudo até você encerrar.',
  phases: [],
  builtIn: true,
};

export const BUILT_IN_WORKOUTS: readonly WorkoutTemplate[] = [
  FREE_WORKOUT,
  {
    id: 'base-60',
    name: 'Base aeróbica · 60 min',
    kind: 'endurance',
    sport: 'bike-indoor',
    description: 'Volume abaixo de VT1, guiado pelo α1. O treino que mais deve se repetir na semana.',
    phases: [
      phase('Aquecimento', 10, Z1, 'Giro leve, cadência confortável.'),
      phase('Base', 45, BELOW_VT1, 'Mantenha o α1 acima de 0,75. Se cair, alivie a carga.'),
      phase('Desaquecimento', 5, Z1, 'Solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'long-90',
    name: 'Longão · 90 min',
    kind: 'endurance',
    sport: 'bike-indoor',
    description: 'Resistência aeróbica. Observe o drift cardíaco na segunda metade.',
    phases: [
      phase('Aquecimento', 10, Z1, 'Comece bem leve.'),
      phase('Contínuo', 75, BELOW_VT1, 'Ritmo de conversa. α1 acima de 0,75.'),
      phase('Desaquecimento', 5, Z1, 'Solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'long-120',
    name: 'Longão · 2 h',
    kind: 'endurance',
    sport: 'bike-indoor',
    description: 'O treino que constrói o motor do triathlon. Leve do começo ao fim; o drift de FC e o α1 no final mostram a durabilidade.',
    phases: [
      phase('Aquecimento', 10, Z1, 'Comece bem leve.'),
      phase('Contínuo', 105, BELOW_VT1, 'Ritmo de conversa. α1 acima de 0,75. Beba água a cada 15 minutos.', null, 90),
      phase('Desaquecimento', 5, Z1, 'Solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'quality-60',
    name: 'Qualidade · 1 h',
    kind: 'threshold',
    sport: 'bike-indoor',
    description: 'Introdução à intensidade moderada (Z3 na escala de 5 zonas): três blocos de 8 min entre VT1 e VT2.',
    phases: [
      phase('Aquecimento', 15, Z1, 'Aqueça progressivamente.'),
      ...repeat(3, [
        phase('Bloco', 8, Z2, 'Firme e controlado, entre VT1 e VT2. Ainda dá para falar frases curtas.', null, 90),
        phase('Recuperação', 4, Z1, 'Alivie a carga.'),
      ]),
      phase('Desaquecimento', 9, Z1, 'Solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'intervals-4x4',
    name: 'Intervalos 4×4',
    kind: 'intervals',
    sport: 'bike-indoor',
    description: 'Quatro tiros de 4 min acima de VT2 com 3 min de recuperação. Alta intensidade da semana.',
    phases: [
      phase('Aquecimento', 12, Z1, 'Aqueça progressivamente.'),
      ...repeat(4, [
        phase('Tiro', 4, Z3, 'Forte. Sustentável pelos 4 minutos inteiros.'),
        phase('Recuperação', 3, Z1, 'Alivie tudo. Respire.'),
      ]),
      phase('Desaquecimento', 8, Z1, 'Solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'threshold-3x10',
    name: 'Limiar 3×10',
    kind: 'threshold',
    sport: 'bike-indoor',
    description: 'Três blocos de 10 min entre VT1 e VT2.',
    phases: [
      phase('Aquecimento', 12, Z1, 'Aqueça progressivamente.'),
      ...repeat(3, [
        phase('Bloco', 10, Z2, 'Firme e controlado, entre VT1 e VT2.'),
        phase('Recuperação', 3, Z1, 'Alivie a carga.'),
      ]),
      phase('Desaquecimento', 8, Z1, 'Solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'ramp-dfa',
    name: 'Rampa DFA · limiares',
    kind: 'ramp',
    sport: 'bike-indoor',
    description: 'Teste incremental. Ao final o app estima HRVT1 e HRVT2 pela queda do α1. Repita a cada 4–6 semanas.',
    phases: [
      phase('Aquecimento', 6, Z1, 'Carga leve, cadência perto de 90 rpm. Fique sentado e parado no tronco.'),
      phase('Rampa', 20, NO_TARGET, 'Suba um nível de carga a cada minuto. Mesma cadência. Vá até não sustentar.', {
        everyS: 60,
        text: 'Suba um nível.',
      }),
      phase('Desaquecimento', 5, Z1, 'Volte para a carga mínima.'),
    ],
    builtIn: true,
  },
  {
    id: 'ramp-ergo',
    name: 'Rampa DFA · ergométrica',
    kind: 'ramp',
    sport: 'bike-indoor',
    description:
      'Teste de limiares para bikes com botão de carga, sem watts. Cadência fixa em 90; a cada 2 min, o mesmo giro do botão para a direita. Cada degrau vira uma volta.',
    phases: [
      phase('Aquecimento', 10, Z1, 'Cadência 90. Ajuste o botão para uma carga leve e marque a posição.', null, 90),
      phase(
        'Rampa',
        36,
        NO_TARGET,
        'A cada aviso, gire o botão o mesmo tanto para a direita. Cadência fixa em 90, sentado, sem falar. Vá até não sustentar.',
        { everyS: 120, text: 'Gire um pouco para a direita.', lap: true },
        90,
      ),
      phase('Desaquecimento', 5, Z1, 'Volte o botão para o início e solte as pernas.'),
    ],
    builtIn: true,
  },
  {
    id: 'recovery-30',
    name: 'Regenerativo · 30 min',
    kind: 'recovery',
    sport: 'bike-indoor',
    description: 'Muito leve. Para o dia seguinte a um treino duro.',
    phases: [phase('Regenerativo', 30, { kind: 'alpha1', min: 0.9, max: null }, 'Bem leve. α1 acima de 0,90.')],
    builtIn: true,
  },
];

export function findTemplate(templates: readonly WorkoutTemplate[], id: string | null): WorkoutTemplate | null {
  if (id === null) return null;
  return templates.find((t) => t.id === id) ?? null;
}

/** Validation for user-edited templates. Returns problems in Portuguese; empty = valid. */
export function validateTemplate(t: WorkoutTemplate): string[] {
  const problems: string[] = [];
  if (!t.name.trim()) problems.push('Dê um nome ao treino.');
  t.phases.forEach((p, i) => {
    if (!p.name.trim()) problems.push(`Fase ${i + 1} sem nome.`);
    if (!(p.durationS >= 10)) problems.push(`Fase ${i + 1} precisa de pelo menos 10 s.`);
    if (p.cadenceRpm !== undefined && !(p.cadenceRpm >= 40 && p.cadenceRpm <= 140)) problems.push(`Fase ${i + 1}: cadência-alvo entre 40 e 140 rpm.`);
    if (p.target.kind === 'alpha1' && p.target.min !== null && p.target.max !== null && p.target.min >= p.target.max) {
      problems.push(`Fase ${i + 1}: o α1 mínimo deve ser menor que o máximo.`);
    }
  });
  return problems;
}
