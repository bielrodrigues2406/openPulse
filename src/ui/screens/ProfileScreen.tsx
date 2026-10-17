import { useEffect, useRef, useState } from 'react';
import { ageOf, effectiveMaxHr, sanitizeProfile, zoneBounds, type AthleteProfile, type Sex } from '../../domain/athlete/profile';
import { NumberField, Section, Segmented, ZONE_COLOR, ZONE_HINT, ZONE_LABEL } from '../components/ui';
import { desktopBridge } from '../desktop';
import { download } from '../download';
import { fmt, shortDay } from '../format';
import { href } from '../router';
import { useData, useHub, useServices } from '../services';
import { exportBackup, importBackup } from '../backup';
import { localDay } from '../../domain/session/recorded-session';

export function ProfileScreen() {
  const d = useData();
  const { data, toast, cues, hub } = useServices();
  const h = useHub();
  const [p, setP] = useState<AthleteProfile>(d.profile);
  useEffect(() => setP(d.profile), [d.profile]);
  const dirty = JSON.stringify(p) !== JSON.stringify(d.profile);
  const age = ageOf(p);
  const max = effectiveMaxHr(p);
  const bounds = zoneBounds(p);
  const set = (patch: Partial<AthleteProfile>) => setP({ ...p, ...patch });
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    const clean = sanitizeProfile(p);
    const manualThresholds = clean.hrvt1 !== d.profile.hrvt1 || clean.hrvt2 !== d.profile.hrvt2;
    await data.saveProfile(manualThresholds ? { ...clean, thresholdsFrom: null } : clean);
    toast('Perfil salvo');
  };

  const s = d.settings;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Perfil</h1>
          <p className="sub">Usado para zonas, calorias e carga. Fica só neste dispositivo.</p>
        </div>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Salvar perfil</button>
      </div>

      <div className="grid-2">
        <Section title="Dados pessoais">
          <div className="form-grid">
            <label className="field wide"><span>Nome</span><input className="input" value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="Como quer ser chamado" /></label>
            <NumberField label="Ano de nascimento" value={p.birthYear} onChange={(v) => set({ birthYear: v })} placeholder="1994" hint={age !== null ? `${age} anos` : undefined} />
            <div className="field">
              <span>Sexo</span>
              <Segmented label="Sexo" value={p.sex ?? ''} onChange={(v: Sex | '') => set({ sex: v === '' ? null : v })} options={[{ value: 'female' as const, label: 'Feminino' }, { value: 'male' as const, label: 'Masculino' }]} />
              <small>Usado só na estimativa de calorias.</small>
            </div>
            <NumberField label="Peso" unit="kg" step={0.1} value={p.weightKg} onChange={(v) => set({ weightKg: v })} />
            <NumberField label="Altura" unit="cm" value={p.heightCm} onChange={(v) => set({ heightCm: v })} />
          </div>
        </Section>

        <Section title="Fisiologia">
          <div className="form-grid">
            <NumberField label="FC de repouso" unit="bpm" value={p.restHr} onChange={(v) => set({ restHr: v })} hint={d.morning.at(-1) ? `último teste matinal: ${fmt(d.morning.at(-1)!.lyingHr)} bpm` : 'medida ao acordar'} />
            <NumberField label="FC máxima" unit="bpm" value={p.maxHr} onChange={(v) => set({ maxHr: v })} placeholder={max?.estimated ? String(max.bpm) : ''} hint={max?.estimated ? `estimada pela idade: ${max.bpm} bpm (±10)` : 'medida em esforço máximo'} />
            <NumberField label="HRVT1 · limiar aeróbico" unit="bpm" value={p.hrvt1} onChange={(v) => set({ hrvt1: v })} />
            <NumberField label="HRVT2 · limiar anaeróbico" unit="bpm" value={p.hrvt2} onChange={(v) => set({ hrvt2: v })} />
          </div>
          <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
            {d.profile.thresholdsFrom
              ? <>Limiares da rampa de {shortDay(localDay(new Date(d.profile.thresholdsFrom.dateIso)))} · <a href={href({ name: 'session', id: d.profile.thresholdsFrom.sessionId })}>ver teste</a></>
              : 'Sem teste: faça a “Rampa DFA” para medir os limiares em vez de estimá-los.'}
          </p>
        </Section>
      </div>

      <div style={{ marginTop: 16 }}>
        <Section title="Suas zonas" meta={bounds ? (bounds.estimated ? 'estimadas pela FC máxima' : 'pelos limiares') : undefined}>
          {bounds ? (
            <div className="zones-table">
              {([1, 2, 3] as const).map((z) => {
                const range = z === 1 ? `< ${bounds.vt1}` : z === 2 ? `${bounds.vt1} – ${bounds.vt2 - 1}` : `≥ ${bounds.vt2}`;
                return (
                  <div key={z} className="zone-row" style={{ borderLeftColor: ZONE_COLOR[z] }}>
                    <div><b>{ZONE_LABEL[z]}</b> <span className="dim">· {ZONE_HINT[z]}</span></div>
                    <div className="num" style={{ fontSize: 20 }}>{range} <small className="faint">bpm</small></div>
                    <div className="faint" style={{ fontSize: 12 }}>{z === 1 ? 'Base aeróbica, conversa fácil. ~80% do volume.' : z === 2 ? 'Moderado. Use com parcimônia.' : 'Intensidade alta. Tiros e intervalos.'}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="dim">Informe ano de nascimento, FC máxima ou os limiares para calcular as zonas.</p>
          )}
        </Section>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Section title="Preferências">
          <label className="toggle"><span>Sons (bipes de fase e alertas)</span><input type="checkbox" checked={s.sound} onChange={(e) => void data.saveSettings({ ...s, sound: e.target.checked })} /></label>
          <label className="toggle">
            <span>Voz (anuncia fases e alvos)</span>
            <input type="checkbox" checked={s.voice} onChange={(e) => void data.saveSettings({ ...s, voice: e.target.checked })} />
          </label>
          <div className="toggle" style={{ cursor: 'default' }}>
            <span>Fonte de dados</span>
            <Segmented
              label="Fonte de dados"
              value={h.source}
              onChange={(v) => { if (h.status.state === 'streaming') return; hub.setSource(v); void data.saveSettings({ ...s, source: v }); }}
              options={[{ value: 'h10' as const, label: 'Polar H10' }, { value: 'sim' as const, label: 'Simulador' }]}
            />
          </div>
          {desktopBridge && (
            <>
              <label className="toggle"><span>Conectar à cinta ao abrir o app</span><input type="checkbox" checked={s.autoConnect} onChange={(e) => void data.saveSettings({ ...s, autoConnect: e.target.checked })} /></label>
              <div className="toggle" style={{ cursor: 'default' }}>
                <span>Cinta lembrada</span>
                <button className="btn sm" onClick={() => { desktopBridge?.forgetDevice(); toast('A próxima conexão vai procurar a cinta de novo'); }}>Esquecer</button>
              </div>
            </>
          )}
          <div style={{ marginTop: 12 }}>
            <button className="btn sm" onClick={() => { cues.unlock(); cues.beep('go'); cues.say('Teste de voz. Zona um.'); }}>Testar som e voz</button>
          </div>
        </Section>

        <Section title="Dados">
          <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
            Tudo fica neste dispositivo. O backup leva perfil, plano, treinos personalizados, sessões e testes matinais (sem o ECG bruto). Use para passar do navegador para o app instalado.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => void exportBackup(data).then((json) => download(`openpulse-backup-${localDay(new Date())}.json`, json, 'application/json'))}>Exportar backup</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>Importar backup</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                void f.text().then((txt) => importBackup(data, txt)).then((n) => toast(`Importado: ${n} sessões`), (err: unknown) => toast(`Falha ao importar: ${err instanceof Error ? err.message : String(err)}`));
              }}
            />
          </div>
        </Section>
      </div>
    </>
  );
}
