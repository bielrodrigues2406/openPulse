import { useMemo } from 'react';
import { driftWindow, hrDriftPct } from '../../domain/analysis/session-analysis';
import { fitnessSeries, thresholdHistory, weeklyLoads } from '../../domain/analysis/trends';
import { zoneBounds } from '../../domain/athlete/profile';
import { readiness } from '../../domain/physiology/orthostatic';
import { localDay } from '../../domain/session/recorded-session';
import { Bars } from '../components/Bars';
import { Timeline } from '../components/Timeline';
import { Section, Stat } from '../components/ui';
import { dm, fmt, plural, shortDay, signed } from '../format';
import { href } from '../router';
import { useData } from '../services';

const DAY_MS = 86_400_000;
function dayIndex(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(new Date(y!, m! - 1, d!).getTime() / DAY_MS);
}
function dayFromIndex(i: number): string {
  return localDay(new Date(i * DAY_MS + 12 * 3600_000));
}
function dateTicks(x0: number, x1: number) {
  const span = x1 - x0;
  const step = span <= 21 ? 7 : span <= 120 ? 14 : span <= 400 ? 30 : 90;
  const out: { t: number; label: string }[] = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) out.push({ t, label: shortDay(dayFromIndex(t)) });
  return out;
}

export function EvolutionScreen() {
  const d = useData();
  const bounds = zoneBounds(d.profile);
  const today = dayIndex(localDay(new Date()));

  const thresholds = useMemo(() => thresholdHistory(d.sessions), [d.sessions]);
  const weeks = useMemo(() => weeklyLoads(d.sessions, bounds, 12), [d.sessions, bounds]);
  const fitness = useMemo(() => (bounds ? fitnessSeries(d.sessions, bounds, 90) : []), [d.sessions, bounds]);
  const morning = d.morning;
  const latestMorning = morning.at(-1) ?? null;
  const ready = latestMorning ? readiness(latestMorning, morning) : null;
  const drift = useMemo(
    () =>
      d.sessions
        .filter((s) => s.status === 'finished' && (s.workout?.kind === 'endurance' || s.workout?.kind === 'free'))
        .flatMap((s) => {
          const w = driftWindow(s);
          const v = w ? hrDriftPct(s.hr, w.fromS, w.toS) : null;
          return v === null ? [] : [{ t: dayIndex(localDay(new Date(s.startedAtIso))), v }];
        })
        .sort((a, b) => a.t - b.t),
    [d.sessions],
  );
  const rolling = useMemo(
    () =>
      morning.map((m, i) => {
        const t = dayIndex(localDay(new Date(m.dateIso)));
        const win = morning.slice(0, i + 1).filter((x) => t - dayIndex(localDay(new Date(x.dateIso))) < 7);
        return { t, v: win.reduce((s, x) => s + x.lnRmssd, 0) / win.length };
      }),
    [morning],
  );

  const firstT = thresholds[0];
  const lastT = thresholds.at(-1);
  const lastFit = fitness.at(-1);
  const thX = () => {
    const a = thresholds.length ? dayIndex(thresholds[0]!.day) - 7 : today - 90;
    return [a, Math.max(today, a + 30)] as const;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Evolução</h1>
          <p className="sub">Limiares, carga de treino e prontidão ao longo das semanas.</p>
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat
          label="HRVT1"
          value={fmt(d.profile.hrvt1)}
          unit="bpm"
          color="var(--z1)"
          note={firstT && lastT && firstT !== lastT && firstT.hrvt1 !== null && lastT.hrvt1 !== null ? `${lastT.hrvt1 - firstT.hrvt1 >= 0 ? '+' : ''}${lastT.hrvt1 - firstT.hrvt1} bpm desde ${shortDay(firstT.day)}` : 'limiar aeróbico'}
        />
        <Stat label="HRVT2" value={fmt(d.profile.hrvt2)} unit="bpm" color="var(--z3)" note="limiar anaeróbico" />
        <Stat label="Forma" value={fmt(lastFit?.ctl ?? null, 0)} note="carga crônica · 42 dias" />
        <Stat label="Fadiga" value={fmt(lastFit?.atl ?? null, 0)} note="carga aguda · 7 dias" />
        <Stat
          label="Equilíbrio"
          value={lastFit ? signed(lastFit.ctl - lastFit.atl) : '—'}
          note={lastFit ? (lastFit.ctl - lastFit.atl < -10 ? 'carga acima do habitual' : 'dentro do habitual') : 'sem carga'}
        />
        <Stat
          label="Prontidão"
          value={ready ? (ready.state === 'calibrating' ? 'calibrando' : ready.state === 'low' ? 'baixa' : ready.state === 'high' ? 'alta' : 'normal') : '—'}
          note={latestMorning ? `teste de ${shortDay(localDay(new Date(latestMorning.dateIso)))}` : <a href={href({ name: 'morning' })}>fazer teste matinal</a>}
        />
      </div>

      <div className="stack">
        <Section title="Limiares pela rampa DFA" meta={plural(thresholds.length, 'teste', 'testes')}>
          {thresholds.length ? (
            <>
              <Timeline
                label="HRVT1 e HRVT2 ao longo do tempo"
                live={false}
                version={thresholds}
                height={200}
                x={thX}
                xTicks={dateTicks}
                y="auto"
                minSpan={30}
                series={[
                  { points: () => thresholds.map((p) => ({ t: dayIndex(p.day), v: p.hrvt1 })), color: '--z1', width: 2 },
                  { points: () => thresholds.map((p) => ({ t: dayIndex(p.day), v: p.hrvt1 })), color: '--z1', dots: true },
                  { points: () => thresholds.map((p) => ({ t: dayIndex(p.day), v: p.hrvt2 })), color: '--z3', width: 2 },
                  { points: () => thresholds.map((p) => ({ t: dayIndex(p.day), v: p.hrvt2 })), color: '--z3', dots: true },
                ]}
              />
              <div className="legend" style={{ marginTop: 8 }}>
                <span><i style={{ background: 'var(--z1)' }} />HRVT1 (α1 0,75)</span>
                <span><i style={{ background: 'var(--z3)' }} />HRVT2 (α1 0,50)</span>
              </div>
            </>
          ) : (
            <div className="empty" style={{ padding: 24 }}>
              <h3>Nenhuma rampa ainda</h3>
              <p>Faça o treino “Rampa DFA · limiares”. Repetido a cada 4–6 semanas, mostra se o limiar aeróbico está subindo.</p>
            </div>
          )}
        </Section>

        <div className="grid-2">
          <Section title="Volume semanal por zona" meta="últimas 12 semanas · minutos">
            <Bars
              unit="min"
              bars={weeks.map((w, i) => ({
                label: i % 2 === (weeks.length - 1) % 2 ? dm(w.monday) : '',
                highlight: i === weeks.length - 1,
                title: `Semana de ${shortDay(w.monday)}: ${Math.round(w.activeS / 60)} min · ${fmt(w.trimp)} TRIMP`,
                parts: w.zonesS
                  ? [
                      { value: w.zonesS[0] / 60, color: 'var(--z1)' },
                      { value: w.zonesS[1] / 60, color: 'var(--z2)' },
                      { value: w.zonesS[2] / 60, color: 'var(--z3)' },
                    ]
                  : [{ value: w.activeS / 60, color: 'var(--line-strong)' }],
              }))}
              empty="Sem treinos nas últimas 12 semanas."
            />
          </Section>
          <Section title="Forma e fadiga" meta="TRIMP · 90 dias">
            {fitness.length && fitness.some((p) => p.load > 0) ? (
              <>
                <Timeline
                  label="Carga crônica e aguda nos últimos 90 dias"
                  live={false}
                  version={fitness}
                  height={190}
                  x={() => [dayIndex(fitness[0]!.day), dayIndex(fitness.at(-1)!.day)] as const}
                  xTicks={dateTicks}
                  y="auto"
                  minSpan={10}
                  series={[
                    { points: () => fitness.map((p) => ({ t: dayIndex(p.day), v: p.ctl })), color: '--text', width: 2 },
                    { points: () => fitness.map((p) => ({ t: dayIndex(p.day), v: p.atl })), color: '--z2', width: 1.4, dashed: true },
                  ]}
                />
                <div className="legend" style={{ marginTop: 8 }}>
                  <span><i style={{ background: 'var(--text)' }} />forma (42 d)</span>
                  <span><i style={{ background: 'var(--z2)' }} />fadiga (7 d)</span>
                </div>
              </>
            ) : (
              <div className="empty" style={{ padding: 24 }}>{bounds ? 'Sem carga nos últimos 90 dias.' : 'Configure o perfil para calcular a carga.'}</div>
            )}
          </Section>
        </div>

        <div className="grid-2">
          <Section title="Prontidão matinal" meta="ln RMSSD deitado · média de 7 dias">
            {morning.length ? (
              <Timeline
                label="ln RMSSD matinal"
                live={false}
                version={morning}
                height={180}
                x={() => [Math.min(dayIndex(localDay(new Date(morning[0]!.dateIso))), today - 30), today] as const}
                xTicks={dateTicks}
                y="auto"
                series={[
                  { points: () => rolling, color: '--sig-rr', width: 1.6 },
                  { points: () => morning.map((m) => ({ t: dayIndex(localDay(new Date(m.dateIso))), v: m.lnRmssd })), color: '--sig-dfa', dots: true },
                ]}
              />
            ) : (
              <div className="empty" style={{ padding: 24 }}>
                <p>3 minutos ao acordar dizem se o corpo absorveu a carga. <a href={href({ name: 'morning' })}>Fazer o teste</a></p>
              </div>
            )}
          </Section>
          <Section title="Drift de FC em treinos longos" meta="% · 2ª vs 1ª metade">
            {drift.length ? (
              <Timeline
                label="Drift de frequência cardíaca"
                live={false}
                version={drift}
                height={180}
                x={() => [drift[0]!.t - 3, Math.max(today, drift[0]!.t + 14)] as const}
                xTicks={dateTicks}
                y="auto"
                minSpan={10}
                refs={[{ y: 5, label: '5%' }]}
                series={[{ points: () => drift, color: '--sig-hr', dots: true }]}
              />
            ) : (
              <div className="empty" style={{ padding: 24 }}>Aparece a partir de treinos contínuos com 20 min ou mais.</div>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
