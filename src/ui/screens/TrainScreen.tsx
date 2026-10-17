import { useEffect, useMemo, useState } from 'react';
import { caloriesFromHr, zoneOf } from '../../domain/athlete/profile';
import { VT1_ALPHA1, VT2_ALPHA1, type DfaPoint } from '../../domain/physiology/dfa-alpha1';
import { localDay, type SessionRecord } from '../../domain/session/recorded-session';
import { mondayOf, resolveWeek } from '../../domain/workouts/week-plan';
import { describeTarget, totalDurationS, type Sport, type TargetState, type WorkoutTemplate } from '../../domain/workouts/workout';
import type { LiveSnapshot } from '../../app/live-session';
import { LiveEcgStrip } from '../components/LiveEcgStrip';
import { Timeline } from '../components/Timeline';
import { Section, Segmented, Stat, ZONE_COLOR, ZONE_HINT, ZONE_LABEL, ZoneBar, ZoneChip } from '../components/ui';
import { KIND_LABEL, SPORT_LABEL, clock, dateTime, duration, fmt } from '../format';
import { IconExpand, IconFlag } from '../icons';
import { useData, useHub, useLive, useServices } from '../services';
import { FocusOverlay } from './FocusOverlay';
import { ReviewSheet } from './ReviewSheet';

const SPORTS: readonly { value: Sport; label: string }[] = [
  { value: 'bike-indoor', label: SPORT_LABEL['bike-indoor'] },
  { value: 'run', label: SPORT_LABEL.run },
  { value: 'other', label: SPORT_LABEL.other },
];

export function TrainScreen() {
  const s = useLive();
  const d = useData();
  const [focus, setFocus] = useState(false);
  const active = s.workout !== null;
  const interrupted = d.sessions.find((x) => x.status === 'open' && x.id !== s.workout?.id && x.id !== s.review?.id) ?? null;

  useShortcuts(active, () => setFocus((f) => !f));

  return (
    <>
      {!active && interrupted && <ResumeBanner rec={interrupted} />}
      {active ? <WorkoutHeader s={s} onFocus={() => setFocus(true)} /> : <StartPanel />}
      <LivePanels s={s} />
      {focus && active && <FocusOverlay onClose={() => setFocus(false)} />}
      {s.review && <ReviewSheet rec={s.review} />}
    </>
  );
}

function useShortcuts(active: boolean, toggleFocus: () => void) {
  const { live } = useServices();
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        live.mark();
      } else if (e.key === 'p' || e.key === 'P') {
        const w = live.getSnapshot().workout;
        if (w?.state === 'running') live.pause();
        else live.unpause();
      } else if (e.key === 'f' || e.key === 'F') toggleFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, live, toggleFocus]);
}

// ── before a workout ──────────────────────────────────────────────────────

function StartPanel() {
  const { live, data, cues } = useServices();
  const d = useData();
  const hub = useHub();
  const today = useMemo(() => {
    const now = new Date();
    return resolveWeek(d.weekPlan, mondayOf(now), d.sessions, d.templates, now).find((x) => x.isToday) ?? null;
  }, [d.weekPlan, d.sessions, d.templates]);
  const pending = today?.planned.filter((p) => !p.doneBy) ?? [];
  const [selected, setSelected] = useState<string>(() => pending[0]?.templateId ?? 'free');
  const [sport, setSport] = useState<Sport>(d.settings.sport);
  useEffect(() => setSport(d.settings.sport), [d.settings.sport]);
  const template = d.templates.find((t) => t.id === selected) ?? d.templates[0]!;
  const connected = hub.status.state === 'streaming';

  const start = () => {
    cues.unlock();
    live.start(template, sport);
    if (sport !== d.settings.sport) void data.saveSettings({ ...d.settings, sport });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Treino</h1>
          <p className="sub">
            {pending.length
              ? `Planejado para hoje: ${pending.map((p) => p.name).join(' + ')}`
              : today?.planned.length
                ? 'O treino planejado de hoje já foi feito.'
                : 'Nada planejado para hoje. Escolha um treino ou monte a semana.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Segmented label="Esporte" value={sport} options={SPORTS} onChange={setSport} />
          <button className="btn primary lg" onClick={start}>
            Iniciar {template.id === 'free' ? 'treino livre' : template.name.split(' · ')[0]}
          </button>
        </div>
      </div>
      {!connected && (
        <p className="notice" style={{ marginBottom: 16 }}>
          A cinta não está conectada. Você pode iniciar agora: a gravação começa no primeiro batimento.
        </p>
      )}
      <div className="template-grid">
        {d.templates.map((t) => (
          <TemplateOption key={t.id} t={t} selected={t.id === selected} planned={pending.some((p) => p.templateId === t.id)} onSelect={() => setSelected(t.id)} />
        ))}
      </div>
    </>
  );
}

function TemplateOption({ t, selected, planned, onSelect }: { t: WorkoutTemplate; selected: boolean; planned: boolean; onSelect: () => void }) {
  const total = totalDurationS(t.phases);
  return (
    <button className="template-option" aria-pressed={selected} onClick={onSelect}>
      <div className="template-top">
        <span className="template-name">{t.name}</span>
        {planned && <span className="tag warn">hoje</span>}
      </div>
      <p className="template-desc">{t.description}</p>
      <div className="template-meta">
        <span>{KIND_LABEL[t.kind]}</span>
        <span>{total ? duration(total) : 'sem duração'}</span>
      </div>
      {t.phases.length > 0 && <PhaseStrip phases={t.phases} />}
    </button>
  );
}

export function PhaseStrip({ phases, progressS }: { phases: WorkoutTemplate['phases']; progressS?: number }) {
  const total = totalDurationS(phases);
  let acc = 0;
  return (
    <div className="phase-strip" aria-hidden>
      {phases.map((p, i) => {
        const start = acc;
        acc += p.durationS;
        const done = progressS !== undefined ? Math.min(1, Math.max(0, (progressS - start) / p.durationS)) : 0;
        const c = p.target.kind === 'zone' ? ZONE_COLOR[p.target.zone] : p.target.kind === 'alpha1' ? 'var(--sig-dfa)' : 'var(--line-strong)';
        return (
          <span key={i} style={{ flexGrow: p.durationS / total, background: c, opacity: progressS === undefined ? 0.75 : 0.35 }} title={`${p.name} · ${duration(p.durationS)}`}>
            {done > 0 && <i style={{ width: `${done * 100}%`, background: c }} />}
          </span>
        );
      })}
    </div>
  );
}

function ResumeBanner({ rec }: { rec: SessionRecord }) {
  const { live, data, toast } = useServices();
  const [busy, setBusy] = useState(false);
  const finishStored = async () => {
    setBusy(true);
    live.resume(rec);
    await live.finish();
    setBusy(false);
  };
  return (
    <div className="banner">
      <div>
        <strong>Treino interrompido</strong>
        <div className="dim" style={{ marginTop: 2 }}>
          {rec.workout?.name ?? 'Treino'} · {duration(rec.durationS)} gravados · começou {dateTime(rec.startedAtIso)}
        </div>
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={() => live.resume(rec)}>Retomar</button>
        <button className="btn" disabled={busy} onClick={() => void finishStored()}>Encerrar e revisar</button>
        <button
          className="btn quiet"
          disabled={busy}
          onClick={() => {
            if (confirm('Descartar este treino? Os dados gravados serão apagados.')) void data.deleteSession(rec.id).then(() => toast('Treino descartado'));
          }}
        >
          Descartar
        </button>
      </div>
    </div>
  );
}

// ── during a workout ──────────────────────────────────────────────────────

function WorkoutHeader({ s, onFocus }: { s: LiveSnapshot; onFocus: () => void }) {
  const { live } = useServices();
  const w = s.workout!;
  const pos = w.position;
  const [confirming, setConfirming] = useState(false);
  const status =
    w.state === 'running' ? (
      <span className="rec-state rec"><i />Gravando</span>
    ) : w.pauseReason === 'sensor' ? (
      <span className="rec-state warn"><i />Pausado · aguardando sinal</span>
    ) : (
      <span className="rec-state"><i />Pausado</span>
    );

  return (
    <div className="workout-head">
      <div className="wh-main">
        <div className="wh-title">
          <h1>{w.name}</h1>
          {status}
        </div>
        <div className="wh-clock num">{clock(w.activeS)}</div>
        {w.totalPlanS > 0 && <div className="faint" style={{ fontSize: 12 }}>de {clock(w.totalPlanS)} planejados · {SPORT_LABEL[w.sport]}</div>}
      </div>

      {pos ? (
        <div className="wh-phase">
          <div className="eyebrow">Fase {pos.index + 1}</div>
          <div className="wh-phase-name">{pos.phase.name}</div>
          <div className="wh-phase-target">
            {describeTarget(pos.phase.target)} <TargetBadge state={w.target} />
          </div>
          {pos.phase.cue && <p className="wh-cue">{pos.phase.cue}</p>}
          <div className="wh-phase-clock num">{clock(pos.phaseRemainingS)}</div>
          {pos.next && <div className="faint" style={{ fontSize: 12 }}>A seguir: {pos.next.name} · {duration(pos.next.durationS)}</div>}
        </div>
      ) : w.planComplete ? (
        <div className="wh-phase">
          <div className="eyebrow">Plano</div>
          <div className="wh-phase-name">Treino completo</div>
          <p className="wh-cue">Continue se quiser; encerre para salvar.</p>
        </div>
      ) : null}

      <div className="wh-actions">
        <button className="btn" onClick={() => live.mark()} disabled={w.state !== 'running'} title="Marcar volta (espaço)">
          <IconFlag width={16} height={16} /> Volta <kbd>␣</kbd>
        </button>
        {w.state === 'running' ? (
          <button className="btn" onClick={() => live.pause()}>Pausar <kbd>P</kbd></button>
        ) : (
          <button className="btn" onClick={() => live.unpause()} disabled={w.pauseReason === 'sensor'}>Continuar <kbd>P</kbd></button>
        )}
        <button className="btn" onClick={onFocus} title="Modo foco (F)"><IconExpand width={16} height={16} /> Foco</button>
        {confirming ? (
          <>
            <button className="btn danger" onClick={() => void live.finish()}>Encerrar agora</button>
            <button className="btn quiet" onClick={() => setConfirming(false)}>Voltar</button>
          </>
        ) : (
          <button className="btn primary" onClick={() => setConfirming(true)}>Encerrar</button>
        )}
      </div>
      {w.totalPlanS > 0 && (
        <div className="wh-progress">
          <PhaseStrip phases={live.plannedPhases()} progressS={w.activeS} />
        </div>
      )}
    </div>
  );
}

export function TargetBadge({ state }: { state: TargetState }) {
  if (state === 'unknown') return null;
  const map = { in: ['No alvo', 'ok'], above: ['Acima — alivie', 'hot'], below: ['Abaixo — pode subir', 'cold'] } as const;
  const [text, tone] = map[state];
  return <span className={`target-badge ${tone}`}>{text}</span>;
}

// ── live panels (preview and workout) ─────────────────────────────────────

export function alphaNote(p: DfaPoint | null): string {
  if (p === null) return 'precisa de 2 min de batimentos';
  if (p.alpha1 === null) return p.reason === 'artifacts' ? 'artefatos > 5% · descartado' : p.reason === 'no-variability' ? 'sem variabilidade' : 'poucos batimentos';
  if (p.alpha1 >= VT1_ALPHA1) return 'abaixo de VT1';
  if (p.alpha1 >= VT2_ALPHA1) return 'entre VT1 e VT2';
  return 'acima de VT2';
}

function LivePanels({ s }: { s: LiveSnapshot }) {
  const { live } = useServices();
  const d = useData();
  const hub = useHub();
  const connected = hub.status.state === 'streaming';
  const b = s.bounds;
  const kcal = s.workout ? caloriesFromHr(live.hr, d.profile) : null;
  const inertial = s.inertial;
  const breath = inertial && inertial.breathsPerMin !== null && inertial.breathConfidence >= 0.3 ? inertial.breathsPerMin : null;
  const rpm = inertial && inertial.rpm !== null && inertial.rpmConfidence >= 0.5 ? inertial.rpm : null;

  if (!connected && s.bpm === null && !s.workout) return null;

  const sessionX = () => {
    const now = live.offsetNow() / 1000;
    return [0, Math.max(now, 600)] as const;
  };
  const lastX = (span: number) => () => {
    const now = live.offsetNow() / 1000;
    return [Math.max(0, now - span), Math.max(now, span)] as const;
  };
  const zoneColor = b ? (v: number) => `--z${zoneOf(v, b)}` : undefined;

  return (
    <div className="live">
      <div className="hero">
        <div className="hero-hr">
          <div className="stat-label">Frequência cardíaca {s.contact === false && <span className="tag warn">sem contato</span>}</div>
          <div className="hero-value num" style={{ color: s.zone ? ZONE_COLOR[s.zone] : undefined }}>
            {fmt(s.bpm)}<small>bpm</small>
          </div>
          <div className="hero-zone">
            <ZoneChip zone={s.zone} />
            {s.zone && <span className="dim" style={{ fontSize: 13 }}>{ZONE_HINT[s.zone]}</span>}
            {b?.estimated && <span className="est" title="Zonas estimadas pela FC máxima; faça a rampa DFA para medir.">EST</span>}
          </div>
          {b ? <ZoneBar bpm={s.bpm} bounds={b} zone={s.zone} /> : (
            <p className="faint" style={{ fontSize: 12 }}>
              Informe idade ou FC máxima no <a href="#/perfil">perfil</a> para ver sua zona.
            </p>
          )}
        </div>
        <div className="hero-alpha">
          <div className="stat-label">DFA α1</div>
          <div className="hero-value num" style={{ color: 'var(--sig-dfa)' }}>{fmt(s.dfa?.alpha1 ?? null, 2)}</div>
          <div className="dim" style={{ fontSize: 13 }}>{alphaNote(s.dfa)}</div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>0,75 e 0,50 são estimativas populacionais de VT1 e VT2</div>
        </div>
      </div>

      <div className="stats live-stats">
        <Stat label="R-R" value={fmt(s.lastRrMs)} unit="ms" />
        <Stat label="RMSSD 60 s" value={fmt(s.rmssdMs, 1)} unit="ms" />
        <Stat label="Artefatos 60 s" value={fmt(s.artifactPct, 1)} unit="%" color={s.artifactPct !== null && s.artifactPct > 5 ? 'var(--danger)' : undefined} title="Acima de 5% o α1 da janela é descartado" />
        <Stat label="Respiração" value={fmt(breath, 0)} unit="irpm" color="var(--sig-breath)" estimate note={inertial?.breathSource === 'both' ? 'tórax + VFC' : inertial?.breathSource === 'rsa' ? 'pela VFC' : inertial?.breathSource === 'acc' ? 'pelo tórax' : 'aguardando 30 s'} />
        <Stat label="Cadência" value={fmt(rpm, 0)} unit="rpm" color="var(--sig-cadence)" estimate note={inertial?.swayMg != null ? `oscilação ${fmt(inertial.swayMg, 0)} mG` : 'pelo acelerômetro'} />
        <Stat label="Energia" value={fmt(kcal, 0)} unit="kcal" estimate note={!s.workout ? 'conta durante o treino' : kcal === null ? 'precisa de sexo, idade e peso' : 'pela FC'} />
      </div>

      <Section title="ECG" meta="130 Hz · 6 s · grade 0,2 s / 0,5 mV">
        <div style={{ height: 170 }}><LiveEcgStrip live={live} /></div>
      </Section>

      <div className="grid-2">
        <Section title="DFA α1" meta="janela 120 s · passo 5 s">
          <Timeline
            label="DFA alfa-1 da sessão"
            x={sessionX}
            y={{ min: 0.2, max: 1.6, step: 0.25, fmt: (v) => v.toFixed(2).replace('.', ',') }}
            refs={[{ y: VT1_ALPHA1, label: 'VT1 est.' }, { y: VT2_ALPHA1, label: 'VT2 est.' }]}
            band={{ from: VT2_ALPHA1, to: VT1_ALPHA1, color: 'rgba(199,165,228,0.07)' }}
            phases={s.workout ? () => ({ phases: live.plannedPhases(), segments: live.segments() }) : undefined}
            series={[{ points: () => live.dfa.map((p) => ({ t: p.tS, v: p.alpha1 })), color: '--sig-dfa', width: 1.8 }]}
            empty="α1 aparece após 2 min de batimentos"
          />
        </Section>
        <Section title="Frequência cardíaca" meta="últimos 10 min">
          <Timeline
            label="Frequência cardíaca, últimos 10 minutos"
            x={lastX(600)}
            y="auto"
            minSpan={30}
            refs={b ? [{ y: b.vt1, label: `VT1 ${b.vt1}` }, { y: b.vt2, label: `VT2 ${b.vt2}` }] : []}
            segments={() => live.segments()}
            series={[{ points: () => live.hr.map((p) => ({ t: p.tS, v: p.bpm })), color: '--sig-hr', width: 2, ...(zoneColor ? { colorOf: zoneColor } : {}) }]}
            empty="Aguardando batimentos"
          />
        </Section>
      </div>

      <div className="grid-3">
        <Section title="Tacograma R-R" meta="2 min · ● rejeitado">
          <Timeline
            label="Intervalos R-R, últimos 2 minutos"
            x={lastX(120)}
            y="auto"
            minSpan={200}
            height={160}
            series={[
              { points: () => live.rr.window(150_000).map((b) => ({ t: b.tMs / 1000, v: b.accepted && !b.gapBefore ? b.rrMs : null })), color: '--sig-rr', width: 1.3 },
              { points: () => live.rr.window(150_000).filter((b) => !b.accepted).map((b) => ({ t: b.tMs / 1000, v: b.rrMs })), color: '--danger', dots: true },
            ]}
          />
        </Section>
        <Section title="Respiração" meta="irpm · estimativa">
          <Timeline
            label="Frequência respiratória estimada"
            x={sessionX}
            y={{ min: 0, max: 60, step: 15 }}
            height={160}
            series={[{ points: () => live.inertial.map((p) => ({ t: p.tS, v: p.breathConfidence >= 0.3 ? p.breathsPerMin : null })), color: '--sig-breath', dots: true }]}
            empty="Aguardando 30 s de movimento"
          />
        </Section>
        <Section title="Cadência" meta="rpm · estimativa">
          <Timeline
            label="Cadência estimada"
            x={sessionX}
            y={{ min: 40, max: 130, step: 30 }}
            height={160}
            series={[{ points: () => live.inertial.map((p) => ({ t: p.tS, v: p.rpmConfidence >= 0.5 ? p.rpm : null })), color: '--sig-cadence', dots: true }]}
            empty="Aguardando pedalada"
          />
        </Section>
      </div>
      {s.zone && <span className="sr-only" aria-live="polite">{ZONE_LABEL[s.zone]}</span>}
    </div>
  );
}

export function todayKey(): string {
  return localDay(new Date());
}
