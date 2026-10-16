import { useCallback, useEffect, useState } from 'react';
import type { IndexedDbSessionRepository } from '../../adapters/indexeddb-session.repository';
import { type SessionRecord, summarize } from '../../domain/session/recorded-session';
import { dfaToCsv, ecgToCsv, fileStem, hrToCsv, rrToCsv, sessionToJson } from '../../domain/session/session-export';
import { download } from '../download';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly sessions: readonly SessionRecord[] }
  | { readonly state: 'error'; readonly message: string };

export function SessionHistory({ repo, refreshKey }: { repo: IndexedDbSessionRepository; refreshKey: unknown }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const refresh = useCallback(() => {
    repo.list().then(
      (sessions) => setLoad({ state: 'ready', sessions }),
      (err: unknown) => setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [repo]);

  useEffect(refresh, [refresh, refreshKey]);

  const act = async (id: string, fn: () => Promise<void> | void) => {
    setRowError(null);
    try {
      await fn();
    } catch (err) {
      setRowError({ id, message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (load.state === 'loading') return <p className="history-note">Carregando sessões…</p>;
  if (load.state === 'error') return <p className="history-note is-error">Não foi possível ler o armazenamento local: {load.message}</p>;
  if (load.sessions.length === 0) {
    return (
      <div className="empty history-empty">
        <p>Nenhuma sessão gravada ainda.</p>
        <p className="empty-sub">Sessões são salvas neste navegador a cada 30 s enquanto a cinta transmite.</p>
      </div>
    );
  }

  return (
    <div className="history">
      <p className="history-note">
        Salvo apenas neste navegador. Limpar os dados do site apaga as sessões — exporte o que quiser guardar.
      </p>
      <table className="history-table">
        <thead>
          <tr>
            <th scope="col">Início</th>
            <th scope="col" className="num">Duração</th>
            <th scope="col" className="num">FC média</th>
            <th scope="col" className="num">FC máx</th>
            <th scope="col" className="num">RMSSD</th>
            <th scope="col" className="num">Artefatos</th>
            <th scope="col" className="num">α1 mín</th>
            <th scope="col">Fonte</th>
            <th scope="col"><span className="sr-only">Ações</span></th>
          </tr>
        </thead>
        <tbody>
          {load.sessions.map((s) => {
            const sum = summarize(s);
            const stem = fileStem(s);
            return (
              <tr key={s.id}>
                <td data-label="Início">{formatStart(s.startedAtIso)}</td>
                <td data-label="Duração" className="num">{formatDuration(s.durationS)}</td>
                <td data-label="FC média" className="num">{fmt(sum.meanBpm, 0)}</td>
                <td data-label="FC máx" className="num">{fmt(sum.maxBpm, 0)}</td>
                <td data-label="RMSSD" className="num">{fmt(sum.rmssdMs, 1, ' ms')}</td>
                <td data-label="Artefatos" className={sum.artifactPct !== null && sum.artifactPct > 5 ? 'num is-error' : 'num'}>
                  {fmt(sum.artifactPct, 1, '%')}
                </td>
                <td data-label="α1 mín" className="num">{fmt(sum.minAlpha1, 2)}</td>
                <td data-label="Fonte" className="dim">{s.source === 'sim' ? 'Simulador' : s.deviceName}</td>
                <td className="actions-cell">
                  <div className="actions">
                  <button onClick={() => act(s.id, () => download(`${stem}.json`, sessionToJson(s), 'application/json'))}>JSON</button>
                  <button onClick={() => act(s.id, () => download(`${stem}-rr.csv`, rrToCsv(s), 'text/csv'))}>R-R</button>
                  <button onClick={() => act(s.id, () => download(`${stem}-hr.csv`, hrToCsv(s), 'text/csv'))}>FC</button>
                  <button disabled={s.dfa.length === 0} onClick={() => act(s.id, () => download(`${stem}-dfa.csv`, dfaToCsv(s), 'text/csv'))}>α1</button>
                  <button
                    disabled={s.ecgSampleCount === 0}
                    onClick={() => act(s.id, async () => download(`${stem}-ecg.csv`, ecgToCsv(s, await repo.ecg(s.id)), 'text/csv'))}
                  >
                    ECG
                  </button>
                  {confirming === s.id ? (
                    <>
                      <button className="danger" onClick={() => act(s.id, async () => { await repo.delete(s.id); setConfirming(null); refresh(); })}>
                        Confirmar exclusão
                      </button>
                      <button onClick={() => setConfirming(null)}>Cancelar</button>
                    </>
                  ) : (
                    <button className="quiet-danger" onClick={() => setConfirming(s.id)}>Excluir</button>
                  )}
                  {rowError?.id === s.id && <span className="row-error" role="alert">{rowError.message}</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: number | null, digits: number, suffix = ''): string {
  return v === null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix;
}

function formatStart(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(sec).padStart(2, '0')}`;
}
