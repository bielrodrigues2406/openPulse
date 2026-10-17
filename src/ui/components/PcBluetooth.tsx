import { useState } from 'react';
import { assessBluetooth, parseBluetoothReport, type Assessment, type FindingLevel } from '../../app/pc-bluetooth';
import { desktopBridge } from '../desktop';
import { useServices } from '../services';
import { Section } from './ui';

const DOT: Record<FindingLevel, string> = { bad: 'error', warn: 'warn', info: '', ok: 'live' };

/** Desktop, Windows: checks adapter, driver, power settings, logged errors and Wi-Fi band. */
export function PcBluetoothSection() {
  const { toast } = useServices();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'running' } | { kind: 'done'; a: Assessment; raw: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  if (!desktopBridge || !navigator.userAgent.includes('Windows')) return null;

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const raw = await desktopBridge!.bluetoothReport();
      setState({ kind: 'done', a: assessBluetooth(parseBluetoothReport(raw), new Date()), raw });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
      setState({ kind: 'error', message });
    }
  };

  const copy = (a: Assessment, raw: string) => {
    const text = [
      'openPulse · Bluetooth do PC',
      ...a.facts.map((f) => `${f.label}: ${f.value}`),
      '',
      ...a.findings.map((f) => `[${f.level}] ${f.title} — ${f.detail}`),
      '',
      raw,
    ].join('\n');
    void navigator.clipboard.writeText(text).then(() => toast('Relatório copiado'));
  };

  return (
    <Section
      title="Bluetooth do PC"
      meta={state.kind === 'done' ? 'análise deste computador' : undefined}
      actions={state.kind === 'done' ? <button className="btn sm" onClick={() => copy(state.a, state.raw)}>Copiar relatório</button> : undefined}
    >
      {state.kind !== 'done' && (
        <>
          <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
            Confere o adaptador, o driver (versão e data), se o Windows desliga o Bluetooth para economizar energia, erros de Bluetooth registrados nos últimos 14 dias e se o Wi-Fi está disputando a mesma faixa. Leva até um minuto; nada é alterado.
          </p>
          <button className="btn" onClick={() => void run()} disabled={state.kind === 'running'}>
            {state.kind === 'running' ? 'Analisando…' : 'Analisar o Bluetooth do PC'}
          </button>
          {state.kind === 'error' && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>Não deu para analisar: {state.message}</p>}
        </>
      )}
      {state.kind === 'done' && (
        <>
          <ul className="findings">
            {state.a.findings.map((f) => (
              <li key={f.title}>
                <span className={`dot ${DOT[f.level]}`} />
                <div>
                  <div className="finding-title">{f.title}</div>
                  <div className="finding-detail">{f.detail}</div>
                </div>
              </li>
            ))}
          </ul>
          <dl className="facts">
            {state.a.facts.map((f) => (
              <div key={f.label + f.value}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          <button className="btn sm" style={{ marginTop: 12 }} onClick={() => void run()}>Analisar de novo</button>
        </>
      )}
    </Section>
  );
}
