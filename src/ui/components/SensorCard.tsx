import { useState } from 'react';
import { useHub, useServices } from '../services';
import { IconBattery } from '../icons';
import { desktopBridge } from '../desktop';

/** Strap status + connect button. Full card in the sidebar, compact pill in the top bar. */
export function SensorCard({ compact = false }: { compact?: boolean }) {
  const { hub, cues, toast } = useServices();
  const h = useHub();
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const s = h.status;
  const live = s.state === 'streaming';
  const busy = s.state === 'connecting';
  const reconnecting = live && s.deviceName.includes('reconectando');
  const tone = s.state === 'error' ? 'error' : busy || reconnecting ? 'busy' : live ? 'live' : '';
  const name = live ? s.deviceName : h.source === 'sim' ? 'Simulador' : 'Polar H10';
  const line = s.state === 'error' ? s.message : busy ? 'Procurando a cinta…' : live ? 'Conectada' : 'Desconectada';

  const toggle = () => {
    cues.unlock();
    if (live) hub.disconnect();
    else void hub.connect();
  };

  if (compact) {
    return (
      <button className="sensor-pill" onClick={toggle} disabled={busy} title={line}>
        <span className={`dot ${tone}`} />
        {live ? (h.battery !== null ? `${h.battery}%` : 'Conectada') : busy ? 'Conectando' : 'Conectar'}
      </button>
    );
  }

  const diag = hub.diagnostics();
  const native = hub.repairable();
  const noEcg = live && s.deviceName.includes('sem ECG');
  const canRepair = h.source === 'h10' && !busy && (native !== null || (desktopBridge !== undefined && !live))
    && (s.state === 'error' || noEcg);
  const repair = async () => {
    setRepairing(true);
    try {
      if (native) await native.repairPairing();
      else if (desktopBridge) {
        const { ok, lines } = await desktopBridge.repairPairing();
        toast(ok ? 'Pareamento removido; conectando de novo' : `Não deu para refazer o pareamento: ${lines.at(-1) ?? 'erro'}`);
      }
    } finally {
      setRepairing(false);
    }
  };
  return (
    <div className="sensor">
      <div className="sensor-row">
        <span className={`dot ${tone}`} />
        <span className="sensor-name">{name}</span>
      </div>
      <div className="sensor-meta">
        <span style={{ color: s.state === 'error' ? 'var(--danger)' : undefined }}>{line}</span>
        {live && h.battery !== null && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <IconBattery /> {h.battery}%
          </span>
        )}
      </div>
      <button className={live ? 'btn' : 'btn primary'} onClick={toggle} disabled={busy}>
        {live ? 'Desconectar' : busy ? 'Conectando…' : 'Conectar cinta'}
      </button>
      {canRepair && (
        <button className="btn" style={{ marginTop: 8 }} onClick={() => void repair()} disabled={repairing}>
          {repairing ? 'Refazendo pareamento…' : 'Refazer pareamento'}
        </button>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
        <button className="linkish" disabled={live || busy} onClick={() => hub.setSource(h.source === 'sim' ? 'h10' : 'sim')}>
          {h.source === 'sim' ? 'Usar Polar H10' : 'Usar simulador'}
        </button>
        {diag && (s.state === 'error' || noEcg) && (
          <button
            className="linkish"
            onClick={() => void navigator.clipboard.writeText(diag.join('\n')).then(() => { setCopied(true); toast('Diagnóstico copiado'); })}
          >
            {copied ? 'copiado' : 'diagnóstico'}
          </button>
        )}
      </div>
    </div>
  );
}
