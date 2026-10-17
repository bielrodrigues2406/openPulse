import { useMemo, useState } from 'react';
import { laps } from '../../domain/analysis/session-analysis';
import { zoneBounds, zoneOf } from '../../domain/athlete/profile';
import { VT1_ALPHA1, VT2_ALPHA1 } from '../../domain/physiology/dfa-alpha1';
import { estimateThresholds } from '../../domain/physiology/thresholds';
import { encodeFit } from '../../domain/session/fit-encoder';
import type { SessionRecord } from '../../domain/session/recorded-session';
import { dfaToCsv, ecgToCsv, fileStem, hrToCsv, inertialToCsv, rrToCsv, sessionToJson } from '../../domain/session/session-export';
import { Timeline } from '../components/Timeline';
import { Section, Segmented, Stat, ZoneDistribution } from '../components/ui';
import { download } from '../download';
import { KIND_LABEL, SPORT_LABEL, clock, dateTime, duration, fmt, plural, signed } from '../format';
import { go, href } from '../router';
import { useData, useServices } from '../services';
import { sessionNumbers } from '../session-numbers';

export function SessionDetail({ id }: { id: string }) {
  const d = useData();
  const rec = d.sessions.find((s) => s.id === id);
  if (!d.loaded) return null;
  if (!rec) {
    return (
      <div className="section empty">
        <h3>Treino não encontrado</h3>
        <p>Ele pode ter sido apagado.</p>
        <a className="btn" href={href({ name: 'history' })}>Voltar ao histórico</a>
      </div>
    );
  }
  return <Detail rec={rec} />;
}

function Detail({ rec }: { rec: SessionRecord }) {
  const d = useData();
  const { data, toast } = useServices();
  const n = useMemo(() => sessionNumbers(rec, d.profile), [rec, d.profile]);
  const bounds = zoneBounds(d.profile, new Date(rec.startedAtIso));
  const lapRows = useMemo(() => laps(rec), [rec]);
  const end = (rec.segments.at(-1)?.endMs ?? rec.durationS * 1000) / 1000;
  const x = () => [0, Math.max(end, 60)] as const;
  const stem = fileStem(rec);
  const [editing, setEditing] = useState(false);
  const th = rec.thresholds;

  const exportEcg = async () => {
    const ecg = await data.sessionsRepo.ecg(rec.id);
    download(`${stem}-ecg.csv`, ecgToCsv({ ...rec, ecgSampleCount: ecg.length }, ecg), 'text/csv');
  };

  const recompute = async () => {
    const t = estimateThresholds(rec.dfa, rec.hr);
    if (!t) {
      toast('α1 insuficiente para estimar limiares');
      return;
    }
    await data.updateSession({ ...rec, thresholds: t });
    toast('Limiares estimados');
  };

  const applyThresholds = async () => {
    if (!th) return;
    await data.saveProfile({ ...d.profile, hrvt1: th.hrvt1 ?? d.profile.hrvt1, hrvt2: th.hrvt2 ?? d.profile.hrvt2, thresholdsFrom: { sessionId: rec.id, dateIso: rec.startedAtIso } });
    toast('Zonas atualizadas');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <a href={href({ name: 'history' })} className="faint" style={{ fontSize: 13, textDecoration: 'none' }}>← Histórico</a>
          <h1 style={{ marginTop: 6 }}>{rec.workout?.name ?? 'Treino'}</h1>
          <p className="sub">
            {dateTime(rec.startedAtIso)} · {SPORT_LABEL[rec.sport]}
            {rec.workout && rec.workout.kind !== 'free' ? ` · ${KIND_LABEL[rec.workout.kind]}` : ''}
            {rec.segments.length > 1 ? ` · ${rec.segments.length} trechos` : ''}
            {rec.status === 'open' ? ' · interrompido' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => download(`${stem}.fit`, encodeFit(rec, { calories: n.kcal }), 'application/vnd.ant.fit')}>Exportar FIT</button>
          <ExportMenu
            items={[
              ['R-R (CSV)', () => download(`${stem}-rr.csv`, rrToCsv(rec), 'text/csv')],
              ['FC (CSV)', () => download(`${stem}-hr.csv`, hrToCsv(rec), 'text/csv')],
              ['α1 (CSV)', () => download(`${stem}-dfa.csv`, dfaToCsv(rec), 'text/csv')],
              ['Respiração e cadência (CSV)', () => download(`${stem}-inertial.csv`, inertialToCsv(rec), 'text/csv')],
              ['ECG (CSV)', () => void exportEcg()],
              ['Sessão completa (JSON)', () => download(`${stem}.json`, sessionToJson(rec), 'application/json')],
            ]}
          />
          <button className="btn" onClick={() => setEditing((e) => !e)}>{editing ? 'Fechar' : 'Editar'}</button>
        </div>
      </div>

      {editing && <EditBox rec={rec} onDone={() => setEditing(false)} />}

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="Duração" value={clock(rec.durationS)} />
        <Stat label="FC média" value={fmt(n.meanBpm)} unit="bpm" />
        <Stat label="FC máx" value={fmt(n.maxBpm)} unit="bpm" />
        <Stat label="Carga" value={fmt(n.trimp)} unit="TRIMP" />
        <Stat label="Energia" value={fmt(n.kcal)} unit="kcal" estimate />
        <Stat label="RMSSD" value={fmt(n.rmssdMs, 1)} unit="ms" />
        <Stat label="α1 mínimo" value={fmt(n.minAlpha1, 2)} color="var(--sig-dfa)" />
        <Stat label="Respiração" value={fmt(n.meanBreaths)} unit="irpm" estimate note="média" />
        <Stat label="Cadência" value={fmt(n.meanRpm)} unit="rpm" estimate note="média" />
        <Stat label="Drift de FC" value={signed(n.driftPct, 1)} unit="%" title="FC da 2ª metade vs 1ª metade do bloco principal" />
        <Stat label="Artefatos" value={fmt(n.artifactPct, 1)} unit="%" color={n.artifactPct !== null && n.artifactPct > 5 ? 'var(--danger)' : undefined} />
        <Stat label="Esforço" value={rec.rpe ?? '—'} unit={rec.rpe ? '/10' : undefined} />
      </div>

      {rec.notes && <p className="notice" style={{ marginBottom: 16, whiteSpace: 'pre-wrap' }}>{rec.notes}</p>}

      <div className="stack">
        {n.zonesS && (
          <Section title="Tempo por zona" meta={bounds?.estimated ? 'zonas estimadas pela FC máx' : `VT1 ${bounds?.vt1} · VT2 ${bounds?.vt2}`}>
            <ZoneDistribution seconds={n.zonesS} />
            <div className="legend" style={{ marginTop: 8 }}>
              {n.zonesS.map((sec, i) => <span key={i} className="num">Z{i + 1} {duration(sec)}</span>)}
            </div>
          </Section>
        )}

        <Section title="Frequência cardíaca" meta="bpm">
          <Timeline
            label="Frequência cardíaca da sessão"
            live={false}
            version={rec}
            x={x}
            y="auto"
            minSpan={30}
            height={220}
            refs={bounds ? [{ y: bounds.vt1, label: `VT1 ${bounds.vt1}` }, { y: bounds.vt2, label: `VT2 ${bounds.vt2}` }] : []}
            phases={rec.workout?.phases.length ? () => ({ phases: rec.workout!.phases, segments: rec.segments }) : undefined}
            segments={() => rec.segments}
            series={[{ points: () => rec.hr.map((p) => ({ t: p.tS, v: p.bpm })), color: '--sig-hr', width: 1.6, ...(bounds ? { colorOf: (v: number) => `--z${zoneOf(v, bounds)}` } : {}) }]}
          />
        </Section>

        <div className="grid-2">
          <Section title="DFA α1" meta="janela 120 s">
            <Timeline
              label="DFA alfa-1 da sessão"
              live={false}
              version={rec}
              x={x}
              y={{ min: 0.2, max: 1.6, step: 0.25, fmt: (v) => v.toFixed(2).replace('.', ',') }}
              refs={[{ y: VT1_ALPHA1, label: 'VT1 est.' }, { y: VT2_ALPHA1, label: 'VT2 est.' }]}
              band={{ from: VT2_ALPHA1, to: VT1_ALPHA1, color: 'rgba(199,165,228,0.07)' }}
              segments={() => rec.segments}
              series={[{ points: () => rec.dfa.map((p) => ({ t: p.tS, v: p.alpha1 })), color: '--sig-dfa', width: 1.8 }]}
              empty="Sessão curta demais para α1"
            />
          </Section>
          <Section title="Respiração e cadência" meta="estimativas">
            <Timeline
              label="Respiração e cadência estimadas"
              live={false}
              version={rec}
              x={x}
              y={{ min: 0, max: 130, step: 30 }}
              segments={() => rec.segments}
              series={[
                { points: () => rec.inertial.map((p) => ({ t: p.tS, v: p.breathConfidence >= 0.3 ? p.breathsPerMin : null })), color: '--sig-breath', dots: true },
                { points: () => rec.inertial.map((p) => ({ t: p.tS, v: p.rpmConfidence >= 0.5 ? p.rpm : null })), color: '--sig-cadence', dots: true },
              ]}
              empty="Sem dados do acelerômetro nesta sessão"
            />
            <div className="legend" style={{ marginTop: 8 }}>
              <span><i style={{ background: 'var(--sig-breath)' }} />respiração (irpm)</span>
              <span><i style={{ background: 'var(--sig-cadence)' }} />cadência (rpm)</span>
            </div>
          </Section>
        </div>

        <Section
          title="Limiares"
          meta={th ? `R² ${fmt(th.r2, 2)} · ${plural(th.points, 'janela', 'janelas')}` : undefined}
          actions={<button className="btn sm" onClick={() => void recompute()}>{th ? 'Recalcular' : 'Estimar pelo α1'}</button>}
        >
          {th ? (
            <div className="threshold-box" style={{ border: 0, background: 'none', padding: 0 }}>
              <div className="threshold-values">
                <div><span>HRVT1</span><b className="num">{fmt(th.hrvt1)}</b><small>bpm</small></div>
                <div><span>HRVT2</span><b className="num">{fmt(th.hrvt2)}</b><small>bpm</small></div>
                <div><span>α1</span><b className="num" style={{ fontSize: 18 }}>{fmt(th.alphaMax, 2)} → {fmt(th.alphaMin, 2)}</b></div>
              </div>
              {th.notes.map((t) => <p key={t} className="dim" style={{ fontSize: 13 }}>{t}</p>)}
              {th.hrvt1 !== null && (
                <div><button className="btn sm" onClick={() => void applyThresholds()}>Usar nas minhas zonas</button></div>
              )}
            </div>
          ) : (
            <p className="dim" style={{ fontSize: 13 }}>
              Os limiares são estimados em testes de rampa (treino “Rampa DFA”). Em outros treinos a estimativa só vale se a intensidade subiu de forma contínua.
            </p>
          )}
        </Section>

        {lapRows.length > 1 && (
          <Section title="Fases e voltas" flush>
            <table className="table">
              <thead>
                <tr><th>Trecho</th><th className="r">Duração</th><th className="r">FC média</th><th className="r">FC máx</th><th className="r">α1 médio</th></tr>
              </thead>
              <tbody>
                {lapRows.map((l, i) => (
                  <tr key={i}>
                    <td>{l.name}</td>
                    <td className="r m">{clock(l.activeS)}</td>
                    <td className="r m">{fmt(l.meanBpm)}</td>
                    <td className="r m">{fmt(l.maxBpm)}</td>
                    <td className="r m">{fmt(l.meanAlpha1, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {n.recoveries.length > 0 && (
          <Section title="Recuperação da FC" meta="queda 60 s após cada tiro">
            <div className="legend" style={{ gap: 24 }}>
              {n.recoveries.map((r, i) => (
                <span key={i}>{r.afterPhase} <b className="num" style={{ color: 'var(--text)', fontWeight: 500 }}>−{fmt(r.dropBpm)}</b> bpm</span>
              ))}
            </div>
          </Section>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm('Apagar este treino? Não dá para desfazer.')) void data.deleteSession(rec.id).then(() => { toast('Treino apagado'); go({ name: 'history' }); });
            }}
          >
            Apagar treino
          </button>
        </div>
      </div>
    </>
  );
}

function ExportMenu({ items }: { items: readonly (readonly [string, () => void])[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Outros formatos ▾</button>
      {open && (
        <div className="menu" role="menu" onMouseLeave={() => setOpen(false)}>
          {items.map(([label, fn]) => (
            <button key={label} role="menuitem" onClick={() => { fn(); setOpen(false); }}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function EditBox({ rec, onDone }: { rec: SessionRecord; onDone: () => void }) {
  const { data, toast } = useServices();
  const [name, setName] = useState(rec.workout?.name ?? 'Treino');
  const [rpe, setRpe] = useState(rec.rpe ?? 0);
  const [notes, setNotes] = useState(rec.notes);
  const [sport, setSport] = useState(rec.sport);
  const save = async () => {
    await data.updateSession({
      ...rec,
      status: 'finished',
      rpe: rpe || null,
      notes: notes.trim(),
      sport,
      workout: rec.workout ? { ...rec.workout, name: name.trim() || rec.workout.name } : { templateId: null, name: name.trim() || 'Treino', kind: 'free', phases: [] },
    });
    toast('Alterações salvas');
    onDone();
  };
  return (
    <div className="section" style={{ marginBottom: 16 }}>
      <div className="section-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="grid-2">
          <label className="field"><span>Nome</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="field"><span>Esporte</span>
            <Segmented label="Esporte" value={sport} onChange={setSport} options={(['bike-indoor', 'run', 'other'] as const).map((v) => ({ value: v, label: SPORT_LABEL[v] }))} />
          </div>
        </div>
        <div className="field"><span>Esforço percebido</span>
          <Segmented className="rpe" label="Esforço percebido" value={rpe} onChange={setRpe} options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => ({ value: v, label: v }))} />
        </div>
        <label className="field"><span>Notas</span><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={onDone}>Cancelar</button>
          <button className="btn primary" onClick={() => void save()}>Salvar</button>
        </div>
      </div>
    </div>
  );
}
