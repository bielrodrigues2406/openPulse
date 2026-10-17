import { totalDurationS, type WorkoutTemplate } from '../../domain/workouts/workout';
import { KIND_LABEL, SPORT_LABEL, duration } from '../format';
import { go, href } from '../router';
import { useData, useServices } from '../services';
import { PhaseStrip } from './TrainScreen';

export function LibraryScreen() {
  const d = useData();
  const { data, toast } = useServices();
  const builtIn = d.templates.filter((t) => t.builtIn);
  const custom = d.templates.filter((t) => !t.builtIn);

  const duplicate = async (t: WorkoutTemplate) => {
    const copy: WorkoutTemplate = { ...t, id: crypto.randomUUID(), name: `${t.name} (cópia)`, builtIn: false };
    await data.saveTemplate(copy);
    toast('Cópia criada');
    go({ name: 'template', id: copy.id });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Treinos</h1>
          <p className="sub">Modelos com fases, alvos por zona ou por α1 e avisos de voz.</p>
        </div>
        <a className="btn primary" href={href({ name: 'template', id: 'novo' })}>Novo treino</a>
      </div>

      {custom.length > 0 && <div className="month" style={{ paddingTop: 0 }}>Meus treinos</div>}
      <div className="lib">
        {custom.map((t) => <Row key={t.id} t={t} onDuplicate={() => void duplicate(t)} />)}
      </div>
      <div className="month">Prontos para usar</div>
      <div className="lib">
        {builtIn.map((t) => <Row key={t.id} t={t} onDuplicate={() => void duplicate(t)} />)}
      </div>
    </>
  );
}

function Row({ t, onDuplicate }: { t: WorkoutTemplate; onDuplicate: () => void }) {
  const total = totalDurationS(t.phases);
  return (
    <div className="lib-row">
      <div className="lib-main">
        <div className="lib-title">
          <span>{t.name}</span>
          <span className="tag">{KIND_LABEL[t.kind]}</span>
          <span className="tag">{SPORT_LABEL[t.sport]}</span>
        </div>
        <p className="dim" style={{ fontSize: 13 }}>{t.description}</p>
        {t.phases.length > 0 && <div style={{ maxWidth: 520, marginTop: 10 }}><PhaseStrip phases={t.phases} /></div>}
      </div>
      <div className="lib-side">
        <span className="num">{total ? duration(total) : '—'}</span>
        <span className="faint" style={{ fontSize: 12 }}>{t.phases.length} fases</span>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {!t.builtIn && <a className="btn sm" href={href({ name: 'template', id: t.id })}>Editar</a>}
          {t.id !== 'free' && <button className="btn sm quiet" onClick={onDuplicate}>Duplicar</button>}
        </div>
      </div>
    </div>
  );
}
