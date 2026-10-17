import { useMemo, useState } from 'react';
import type { SessionRecord } from '../../domain/session/recorded-session';
import type { Sport } from '../../domain/workouts/workout';
import { Segmented, Sheet, Stat, ZoneDistribution } from '../components/ui';
import { SPORT_LABEL, clock, fmt } from '../format';
import { go } from '../router';
import { useData, useServices } from '../services';
import { sessionNumbers } from '../session-numbers';

const RPE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const RPE_TEXT = ['', 'muito leve', 'leve', 'leve', 'moderado', 'moderado', 'firme', 'difícil', 'muito difícil', 'quase máximo', 'máximo'];

/** After "Encerrar": what happened, how it felt, and — after a ramp — the new thresholds. */
export function ReviewSheet({ rec }: { rec: SessionRecord }) {
  const { live, data, toast } = useServices();
  const d = useData();
  const n = useMemo(() => sessionNumbers(rec, d.profile), [rec, d.profile]);
  const [name, setName] = useState(rec.workout?.name ?? 'Treino livre');
  const [sport, setSport] = useState<Sport>(rec.sport);
  const [rpe, setRpe] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const th = rec.thresholds;
  const [applyThresholds, setApply] = useState(th !== null && th.hrvt1 !== null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const done = await live.saveReview({ rpe, notes, sport, name });
    if (done && applyThresholds && th) {
      await data.saveProfile({
        ...d.profile,
        hrvt1: th.hrvt1 ?? d.profile.hrvt1,
        hrvt2: th.hrvt2 ?? d.profile.hrvt2,
        thresholdsFrom: { sessionId: done.id, dateIso: done.startedAtIso },
      });
    }
    await data.refreshSessions();
    toast('Treino salvo');
    if (done) go({ name: 'session', id: done.id });
  };

  const discard = async () => {
    if (!confirm('Descartar este treino? Os dados gravados serão apagados.')) return;
    setBusy(true);
    await live.discardReview();
    await data.refreshSessions();
    toast('Treino descartado');
  };

  return (
    <Sheet
      title="Treino encerrado"
      sub={`${clock(rec.durationS)} gravados${rec.segments.length > 1 ? ` em ${rec.segments.length} trechos` : ''}`}
      footer={
        <>
          <button className="btn quiet" disabled={busy} onClick={() => void discard()}>Descartar</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>Salvar treino</button>
        </>
      }
    >
      <div className="stats" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <Stat label="FC média" value={fmt(n.meanBpm)} unit="bpm" />
        <Stat label="FC máx" value={fmt(n.maxBpm)} unit="bpm" />
        <Stat label="Carga" value={fmt(n.trimp)} unit="TRIMP" title="Lucia TRIMP: minutos por zona × 1/2/3" />
        <Stat label="Energia" value={fmt(n.kcal)} unit="kcal" estimate />
      </div>
      {n.zonesS && <ZoneDistribution seconds={n.zonesS} />}

      {th && (
        <div className="threshold-box">
          <div className="eyebrow">Limiares pela rampa</div>
          <div className="threshold-values">
            <div><span>HRVT1</span><b className="num">{fmt(th.hrvt1)}</b><small>bpm</small></div>
            <div><span>HRVT2</span><b className="num">{fmt(th.hrvt2)}</b><small>bpm</small></div>
            <div><span>Ajuste</span><b className="num">{fmt(th.r2, 2)}</b><small>R²</small></div>
          </div>
          {th.notes.map((t) => <p key={t} className="dim" style={{ fontSize: 13 }}>{t}</p>)}
          {th.hrvt1 !== null && (
            <label className="toggle" style={{ borderBottom: 0, paddingBottom: 0 }}>
              <span>Atualizar minhas zonas com estes limiares</span>
              <input type="checkbox" checked={applyThresholds} onChange={(e) => setApply(e.target.checked)} />
            </label>
          )}
        </div>
      )}

      <div className="grid-2">
        <label className="field">
          <span>Nome</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>Esporte</span>
          <Segmented label="Esporte" value={sport} onChange={setSport} options={(['bike-indoor', 'run', 'other'] as const).map((v) => ({ value: v, label: SPORT_LABEL[v] }))} />
        </div>
      </div>
      <div className="field">
        <span>Esforço percebido {rpe !== null && <b style={{ color: 'var(--text)', fontWeight: 500 }}>· {RPE_TEXT[rpe]}</b>}</span>
        <Segmented className="rpe" label="Esforço percebido de 1 a 10" value={rpe ?? 0} onChange={(v) => setRpe(v)} options={RPE.map((v) => ({ value: v, label: v }))} />
      </div>
      <label className="field">
        <span>Notas</span>
        <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Como foi? Sono, alimentação, sensação nas pernas…" />
      </label>
    </Sheet>
  );
}
