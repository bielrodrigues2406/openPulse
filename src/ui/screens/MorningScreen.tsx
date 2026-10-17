import { readiness, ORTHO_LYING_S, ORTHO_STANDING_S, type OrthostaticResult } from '../../domain/physiology/orthostatic';
import { Section, Stat } from '../components/ui';
import { dayLabel, fmt, plural, signed, timeOnly } from '../format';
import { useData, useHub, useMorning, useServices } from '../services';

const READY_TEXT = {
  low: ['Abaixo do seu normal', 'Considere um treino leve ou descanso hoje.', 'var(--z3)'],
  normal: ['Dentro do seu normal', 'Siga o plano.', 'var(--ok)'],
  high: ['Acima do seu normal', 'Geralmente bom sinal; observe se repete.', 'var(--focus)'],
} as const;

export function MorningScreen() {
  const { morning, hub, cues, data, toast } = useServices();
  const st = useMorning();
  const h = useHub();
  const d = useData();
  const connected = h.status.state === 'streaming';
  const history = [...d.morning].reverse();

  const start = () => {
    cues.unlock();
    morning.start(hub.current());
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Teste matinal</h1>
          <p className="sub">3 minutos ao acordar, antes do café: 90 s deitado, levanta, 90 s em pé.</p>
        </div>
        {(st.step === 'idle' || st.step === 'done' || st.step === 'failed') && (
          <button className="btn primary lg" onClick={start} disabled={!connected}>
            {connected ? 'Começar teste' : 'Conecte a cinta'}
          </button>
        )}
      </div>

      {(st.step === 'lying' || st.step === 'standing') && (
        <div className="morning-run">
          <div className="eyebrow">{st.step === 'lying' ? 'Etapa 1 de 2' : 'Etapa 2 de 2'}</div>
          <h2>{st.step === 'lying' ? 'Deitado, imóvel' : 'Em pé, parado'}</h2>
          <div className="morning-clock num">{st.remainingS}<small>s</small></div>
          <div className="morning-progress">
            <span style={{ width: `${(1 - st.remainingS / (st.step === 'lying' ? ORTHO_LYING_S : ORTHO_STANDING_S)) * 100}%` }} />
          </div>
          <div className="morning-live">
            <span><b className="num">{fmt(st.bpm)}</b> bpm</span>
            <span><b className="num">{st.beats}</b> batimentos</span>
          </div>
          <p className="dim">{st.step === 'lying' ? 'Respire normalmente. Você vai ouvir quando for hora de levantar.' : 'Fique parado, braços soltos. Falta pouco.'}</p>
          <button className="btn quiet" onClick={() => morning.cancel()}>Cancelar</button>
        </div>
      )}

      {st.step === 'failed' && <p className="notice" style={{ marginBottom: 16, color: 'var(--danger)' }}>{st.reason}</p>}
      {st.step === 'done' && <Result r={st.result} history={d.morning} />}
      {st.step === 'idle' && history[0] && <Result r={history[0]} history={d.morning} />}

      <Section title="Histórico" meta={plural(history.length, 'teste', 'testes')} flush>
        {history.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Dia</th><th className="r">ln RMSSD</th><th className="r">RMSSD</th><th className="r">FC deitado</th><th className="r hide-sm">FC em pé</th><th className="r hide-sm">Pico</th><th className="r hide-md">Artefatos</th><th />
                </tr>
              </thead>
              <tbody>
                {history.map((m) => (
                  <tr key={m.id}>
                    <td>{dayLabel(m.dateIso)} <span className="faint m" style={{ fontSize: 12 }}>{timeOnly(m.dateIso)}</span></td>
                    <td className="r m">{fmt(m.lnRmssd, 2)}</td>
                    <td className="r m">{fmt(m.lyingRmssd, 0)}</td>
                    <td className="r m">{fmt(m.lyingHr, 0)}</td>
                    <td className="r m hide-sm">{fmt(m.standingHr, 0)}</td>
                    <td className="r m hide-sm">{fmt(m.peakHr, 0)}</td>
                    <td className="r m hide-md">{fmt(m.artifactPct, 1)}%</td>
                    <td className="r">
                      <button className="btn sm quiet" onClick={() => { if (confirm('Apagar este teste?')) void data.deleteMorning(m.id).then(() => toast('Teste apagado')); }}>Apagar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty"><p>Faça o teste por 3 manhãs para o app aprender o seu normal.</p></div>
        )}
      </Section>
    </>
  );
}

function Result({ r, history }: { r: OrthostaticResult; history: readonly OrthostaticResult[] }) {
  const rd = readiness(r, history);
  return (
    <div className="stack" style={{ marginBottom: 16 }}>
      <div className="section" style={{ padding: '18px 20px' }}>
        <div className="eyebrow">Resultado de {dayLabel(r.dateIso)}</div>
        {rd.state === 'calibrating' ? (
          <p style={{ fontSize: 18, marginTop: 6 }}>Calibrando: faltam {rd.needed} {rd.needed === 1 ? 'teste' : 'testes'} para ter a sua referência.</p>
        ) : (
          <>
            <p style={{ fontSize: 22, fontWeight: 600, marginTop: 6, color: READY_TEXT[rd.state][2] }}>{READY_TEXT[rd.state][0]}</p>
            <p className="dim">{READY_TEXT[rd.state][1]} Referência dos últimos 7 dias: {fmt(rd.mean, 2)} ± {fmt(rd.sd, 2)}. Isto é uma orientação, não um diagnóstico.</p>
          </>
        )}
      </div>
      <div className="stats">
        <Stat label="ln RMSSD deitado" value={fmt(r.lnRmssd, 2)} color="var(--sig-dfa)" />
        <Stat label="RMSSD deitado" value={fmt(r.lyingRmssd, 0)} unit="ms" />
        <Stat label="FC deitado" value={fmt(r.lyingHr, 0)} unit="bpm" />
        <Stat label="FC em pé" value={fmt(r.standingHr, 0)} unit="bpm" note={`${signed(r.standingHr - r.lyingHr)} bpm ao levantar`} />
        <Stat label="Pico ao levantar" value={fmt(r.peakHr, 0)} unit="bpm" />
        <Stat label="RMSSD em pé" value={fmt(r.standingRmssd, 0)} unit="ms" />
      </div>
    </div>
  );
}
