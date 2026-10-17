import { useMemo } from 'react';
import { ZoneDistribution } from '../components/ui';
import { KIND_LABEL, SPORT_LABEL, dayLabel, duration, fmt, monthTitle, timeOnly } from '../format';
import { go, href } from '../router';
import { useData } from '../services';
import { sessionNumbers } from '../session-numbers';

export function HistoryScreen() {
  const d = useData();
  const groups = useMemo(() => {
    const out: { month: string; rows: typeof d.sessions[number][] }[] = [];
    for (const s of d.sessions) {
      const m = s.startedAtIso.slice(0, 7);
      const g = out.at(-1);
      if (g && g.month === m) g.rows.push(s);
      else out.push({ month: m, rows: [s] });
    }
    return out;
  }, [d.sessions]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Histórico</h1>
          <p className="sub">{d.sessions.length ? `${d.sessions.length} treinos gravados neste dispositivo` : 'Os treinos que você gravar aparecem aqui.'}</p>
        </div>
      </div>
      {!d.sessions.length && d.loaded && (
        <div className="section empty">
          <h3>Nenhum treino ainda</h3>
          <p>Conecte a cinta e inicie um treino. Tudo fica salvo localmente, com exportação em FIT, CSV e JSON.</p>
          <a className="btn primary" href={href({ name: 'train' })}>Ir para Treino</a>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.month}>
          <div className="month">{monthTitle(`${g.month}-15T12:00:00`)}</div>
          <div className="section" style={{ overflowX: 'auto' }}>
            <table className="table history">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Treino</th>
                  <th className="r">Duração</th>
                  <th className="r hide-sm">FC média</th>
                  <th className="r hide-sm">Carga</th>
                  <th className="hide-md" style={{ width: 180 }}>Zonas</th>
                  <th className="r hide-md">α1 mín</th>
                  <th className="r hide-sm">RPE</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((s) => {
                  const n = sessionNumbers(s, d.profile);
                  return (
                    <tr key={s.id} className="click" onClick={() => go({ name: 'session', id: s.id })}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{dayLabel(s.startedAtIso)}</div>
                        <div className="faint m" style={{ fontSize: 12 }}>{timeOnly(s.startedAtIso)}</div>
                      </td>
                      <td>
                        <a href={href({ name: 'session', id: s.id })} style={{ textDecoration: 'none', fontWeight: 500 }} onClick={(e) => e.stopPropagation()}>
                          {s.workout?.name ?? 'Treino'}
                        </a>
                        <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                          <span className="tag">{SPORT_LABEL[s.sport]}</span>
                          {s.workout && s.workout.kind !== 'free' && <span className="tag">{KIND_LABEL[s.workout.kind]}</span>}
                          {s.thresholds?.hrvt1 != null && <span className="tag dfa">limiares</span>}
                          {s.status === 'open' && <span className="tag warn">interrompido</span>}
                        </div>
                      </td>
                      <td className="r m">{duration(s.durationS)}</td>
                      <td className="r m hide-sm">{fmt(n.meanBpm)}</td>
                      <td className="r m hide-sm">{fmt(n.trimp)}</td>
                      <td className="hide-md">{n.zonesS ? <ZoneDistribution seconds={n.zonesS} showLegend={false} /> : <span className="faint">—</span>}</td>
                      <td className="r m hide-md">{fmt(n.minAlpha1, 2)}</td>
                      <td className="r m hide-sm">{s.rpe ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
