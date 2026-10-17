import { useState } from 'react';
import { describeTarget, totalDurationS, validateTemplate, type Phase, type Sport, type Target, type WorkoutKind, type WorkoutTemplate } from '../../domain/workouts/workout';
import { Segmented } from '../components/ui';
import { KIND_LABEL, SPORT_LABEL, duration, plural } from '../format';
import { go, href } from '../router';
import { useData, useServices } from '../services';
import { PhaseStrip } from './TrainScreen';

type TargetKey = 'none' | 'z1' | 'z2' | 'z3' | 'a-min' | 'a-max' | 'a-range';

function targetKey(t: Target): TargetKey {
  if (t.kind === 'none') return 'none';
  if (t.kind === 'zone') return `z${t.zone}` as TargetKey;
  if (t.min !== null && t.max !== null) return 'a-range';
  return t.min !== null ? 'a-min' : 'a-max';
}

function targetFrom(key: TargetKey, prev: Target): Target {
  const min = prev.kind === 'alpha1' ? prev.min : null;
  const max = prev.kind === 'alpha1' ? prev.max : null;
  switch (key) {
    case 'none': return { kind: 'none' };
    case 'z1': return { kind: 'zone', zone: 1 };
    case 'z2': return { kind: 'zone', zone: 2 };
    case 'z3': return { kind: 'zone', zone: 3 };
    case 'a-min': return { kind: 'alpha1', min: min ?? 0.75, max: null };
    case 'a-max': return { kind: 'alpha1', min: null, max: max ?? 0.75 };
    case 'a-range': return { kind: 'alpha1', min: min ?? 0.5, max: max ?? 0.75 };
  }
}

const BLANK_PHASE: Phase = { name: 'Fase', durationS: 300, target: { kind: 'none' }, cue: '', repeatCue: null };

export function TemplateEditor({ id }: { id: string }) {
  const d = useData();
  const { data, toast } = useServices();
  const existing = d.templates.find((t) => t.id === id);
  if (!d.loaded) return null;
  if (existing?.builtIn) {
    return (
      <div className="section empty">
        <h3>Modelo pronto</h3>
        <p>Os modelos prontos não são editáveis. Duplique para criar a sua versão.</p>
        <a className="btn" href={href({ name: 'library' })}>Voltar</a>
      </div>
    );
  }
  return <Editor key={id} initial={existing ?? null} onSaved={(t) => { toast('Treino salvo'); go({ name: 'template', id: t.id }); }} save={(t) => data.saveTemplate(t)} remove={(tid) => data.deleteTemplate(tid)} />;
}

function Editor(p: { initial: WorkoutTemplate | null; save: (t: WorkoutTemplate) => Promise<void>; remove: (id: string) => Promise<void>; onSaved: (t: WorkoutTemplate) => void }) {
  const { toast } = useServices();
  const [t, setT] = useState<WorkoutTemplate>(
    () => p.initial ?? { id: crypto.randomUUID(), name: '', kind: 'endurance', sport: 'bike-indoor', description: '', phases: [{ ...BLANK_PHASE, name: 'Aquecimento', durationS: 600, target: { kind: 'zone', zone: 1 } }], builtIn: false },
  );
  const [problems, setProblems] = useState<string[]>([]);
  const setPhase = (i: number, patch: Partial<Phase>) => setT({ ...t, phases: t.phases.map((ph, k) => (k === i ? { ...ph, ...patch } : ph)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= t.phases.length) return;
    const ph = [...t.phases];
    [ph[i], ph[j]] = [ph[j]!, ph[i]!];
    setT({ ...t, phases: ph });
  };

  const submit = async () => {
    const issues = validateTemplate(t);
    setProblems(issues);
    if (issues.length) return;
    await p.save(t);
    p.onSaved(t);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <a href={href({ name: 'library' })} className="faint" style={{ fontSize: 13, textDecoration: 'none' }}>← Treinos</a>
          <h1 style={{ marginTop: 6 }}>{p.initial ? 'Editar treino' : 'Novo treino'}</h1>
          <p className="sub">{plural(t.phases.length, 'fase', 'fases')} · {duration(totalDurationS(t.phases))}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {p.initial && (
            <button className="btn danger" onClick={() => { if (confirm('Excluir este treino?')) void p.remove(t.id).then(() => { toast('Treino excluído'); go({ name: 'library' }); }); }}>Excluir</button>
          )}
          <button className="btn primary" onClick={() => void submit()}>Salvar</button>
        </div>
      </div>

      {problems.length > 0 && <div className="notice" style={{ marginBottom: 16, color: 'var(--danger)' }}>{problems.join(' ')}</div>}

      <div className="section" style={{ marginBottom: 16 }}>
        <div className="section-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="grid-2">
            <label className="field"><span>Nome</span><input className="input" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Ex.: Sweet spot 2×20" /></label>
            <label className="field">
              <span>Tipo</span>
              <select className="select" value={t.kind} onChange={(e) => setT({ ...t, kind: e.target.value as WorkoutKind })}>
                {(Object.keys(KIND_LABEL) as WorkoutKind[]).filter((k) => k !== 'free').map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
              {t.kind === 'ramp' && <small>Tipo “Teste”: ao encerrar, o app estima HRVT1 e HRVT2.</small>}
            </label>
          </div>
          <label className="field"><span>Descrição</span><input className="input" value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} placeholder="Objetivo do treino" /></label>
          <div className="field">
            <span>Esporte</span>
            <Segmented label="Esporte" value={t.sport} onChange={(v: Sport) => setT({ ...t, sport: v })} options={(['bike-indoor', 'run', 'other'] as const).map((v) => ({ value: v, label: SPORT_LABEL[v] }))} />
          </div>
          {t.phases.length > 0 && <PhaseStrip phases={t.phases} />}
        </div>
      </div>

      <div className="phases">
        {t.phases.map((ph, i) => (
          <div key={i} className="phase-row">
            <div className="phase-idx num">{i + 1}</div>
            <div className="phase-fields">
              <label className="field"><span>Nome</span><input className="input" value={ph.name} onChange={(e) => setPhase(i, { name: e.target.value })} /></label>
              <div className="field">
                <span>Duração</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div className="input-unit"><input className="input num" type="number" min={0} value={Math.floor(ph.durationS / 60)} onChange={(e) => setPhase(i, { durationS: Math.max(0, Number(e.target.value)) * 60 + (ph.durationS % 60) })} /><em>min</em></div>
                  <div className="input-unit"><input className="input num" type="number" min={0} max={59} value={ph.durationS % 60} onChange={(e) => setPhase(i, { durationS: Math.floor(ph.durationS / 60) * 60 + Math.min(59, Math.max(0, Number(e.target.value))) })} /><em>s</em></div>
                </div>
              </div>
              <label className="field">
                <span>Alvo</span>
                <select className="select" value={targetKey(ph.target)} onChange={(e) => setPhase(i, { target: targetFrom(e.target.value as TargetKey, ph.target) })}>
                  <option value="none">Livre</option>
                  <option value="z1">Zona 1 · abaixo de VT1</option>
                  <option value="z2">Zona 2 · entre VT1 e VT2</option>
                  <option value="z3">Zona 3 · acima de VT2</option>
                  <option value="a-min">α1 acima de…</option>
                  <option value="a-max">α1 abaixo de…</option>
                  <option value="a-range">α1 entre…</option>
                </select>
              </label>
              {ph.target.kind === 'alpha1' && (
                <div className="field">
                  <span>{describeTarget(ph.target)}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {ph.target.min !== null && <input aria-label="α1 mínimo" className="input num" type="number" step={0.05} value={ph.target.min} onChange={(e) => setPhase(i, { target: { ...(ph.target as Extract<Target, { kind: 'alpha1' }>), min: Number(e.target.value) } })} />}
                    {ph.target.max !== null && <input aria-label="α1 máximo" className="input num" type="number" step={0.05} value={ph.target.max} onChange={(e) => setPhase(i, { target: { ...(ph.target as Extract<Target, { kind: 'alpha1' }>), max: Number(e.target.value) } })} />}
                  </div>
                </div>
              )}
              <label className="field wide"><span>Instrução falada ao começar</span><input className="input" value={ph.cue} onChange={(e) => setPhase(i, { cue: e.target.value })} placeholder="Ex.: Cadência 90, respiração solta." /></label>
              <label className="field">
                <span>Repetir aviso a cada</span>
                <div className="input-unit">
                  <input className="input num" type="number" min={0} value={ph.repeatCue?.everyS ?? ''} placeholder="—" onChange={(e) => { const v = Number(e.target.value); setPhase(i, { repeatCue: v > 0 ? { everyS: v, text: ph.repeatCue?.text ?? 'Suba um nível.' } : null }); }} />
                  <em>s</em>
                </div>
              </label>
              {ph.repeatCue && <label className="field"><span>Texto do aviso</span><input className="input" value={ph.repeatCue.text} onChange={(e) => setPhase(i, { repeatCue: { everyS: ph.repeatCue!.everyS, text: e.target.value } })} /></label>}
            </div>
            <div className="phase-actions">
              <button className="btn sm quiet" aria-label="Mover para cima" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button className="btn sm quiet" aria-label="Mover para baixo" onClick={() => move(i, 1)} disabled={i === t.phases.length - 1}>↓</button>
              <button className="btn sm quiet" aria-label="Duplicar fase" onClick={() => setT({ ...t, phases: [...t.phases.slice(0, i + 1), { ...ph }, ...t.phases.slice(i + 1)] })}>⧉</button>
              <button className="btn sm quiet" aria-label="Remover fase" onClick={() => setT({ ...t, phases: t.phases.filter((_, k) => k !== i) })}>×</button>
            </div>
          </div>
        ))}
        <button className="btn" onClick={() => setT({ ...t, phases: [...t.phases, { ...BLANK_PHASE, name: `Fase ${t.phases.length + 1}` }] })}>+ Adicionar fase</button>
      </div>
    </>
  );
}
