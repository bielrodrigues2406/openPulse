import { useMemo, useState } from 'react';
import { weeklyLoads } from '../../domain/analysis/trends';
import { zoneBounds } from '../../domain/athlete/profile';
import { ALL_PRESETS, EMPTY_WEEK, WEEKDAYS, addDays, mondayOf, resolveWeek, type WeekPlan } from '../../domain/workouts/week-plan';
import { ZoneDistribution } from '../components/ui';
import { KIND_LABEL, duration, fmt, plural, shortDay } from '../format';
import { href } from '../router';
import { useData, useServices } from '../services';

export function WeekScreen() {
  const d = useData();
  const { data, toast } = useServices();
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [editing, setEditing] = useState(false);
  const days = useMemo(() => resolveWeek(d.weekPlan, monday, d.sessions, d.templates), [d.weekPlan, monday, d.sessions, d.templates]);
  const bounds = zoneBounds(d.profile);
  const isThisWeek = mondayOf(new Date()).getTime() === monday.getTime();

  const load = useMemo(() => {
    const ref = addDays(monday, 3);
    return weeklyLoads(d.sessions, bounds, 1, ref)[0]!;
  }, [d.sessions, bounds, monday]);
  const plannedS = days.reduce((s, x) => s + x.planned.reduce((a, p) => a + p.durationS, 0), 0);
  const doneCount = days.reduce((s, x) => s + x.planned.filter((p) => p.doneBy).length, 0);
  const plannedCount = days.reduce((s, x) => s + x.planned.length, 0);

  const savePlan = async (p: WeekPlan) => {
    await data.saveWeekPlan(p);
  };

  const range = `${shortDay(days[0]!.day)} – ${shortDay(days[6]!.day)}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Semana</h1>
          <p className="sub">{range}{isThisWeek ? ' · esta semana' : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setMonday(addDays(monday, -7))} aria-label="Semana anterior">‹</button>
          <button className="btn" onClick={() => setMonday(mondayOf(new Date()))} disabled={isThisWeek}>Hoje</button>
          <button className="btn" onClick={() => setMonday(addDays(monday, 7))} aria-label="Próxima semana">›</button>
          <button className={editing ? 'btn primary' : 'btn'} onClick={() => setEditing((e) => !e)}>{editing ? 'Concluir' : 'Estruturar semana'}</button>
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-label">Volume</div>
          <div className="stat-value">{duration(load.activeS)}<small>de {duration(plannedS)}</small></div>
        </div>
        <div className="stat">
          <div className="stat-label">Treinos do plano</div>
          <div className="stat-value">{doneCount}<small>de {plannedCount}</small></div>
          <div className="stat-note">{plural(load.sessions, 'sessão', 'sessões')} no total</div>
        </div>
        <div className="stat">
          <div className="stat-label">Carga</div>
          <div className="stat-value">{fmt(load.trimp)}<small>TRIMP</small></div>
        </div>
        <div className="stat" style={{ gridColumn: 'span 2' }}>
          <div className="stat-label">Distribuição por zona</div>
          <div style={{ marginTop: 12 }}>
            {load.zonesS && load.zonesS.some((x) => x > 0) ? <ZoneDistribution seconds={load.zonesS} /> : <span className="faint">{bounds ? 'Nenhum treino nesta semana.' : 'Configure o perfil para ver zonas.'}</span>}
          </div>
          <div className="stat-note">Referência polarizada: ~80% do tempo em Leve</div>
        </div>
      </div>

      {editing && (
        <div className="notice" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>A estrutura se repete toda semana. Treinos feitos com o mesmo modelo marcam o planejado como concluído.</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <select
              className="select"
              style={{ height: 32, width: 'auto', fontSize: 13 }}
              value=""
              aria-label="Aplicar um modelo de semana"
              onChange={(e) => {
                const preset = ALL_PRESETS.find((x) => x.id === e.target.value);
                if (preset) void savePlan(preset.plan).then(() => toast(`Aplicado: ${preset.name}`));
              }}
            >
              <option value="">Aplicar modelo…</option>
              {ALL_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <button className="btn sm quiet" onClick={() => void savePlan(EMPTY_WEEK)}>Limpar</button>
          </span>
        </div>
      )}

      <div className="week">
        {days.map((day) => (
          <div key={day.day} className={`day${day.isToday ? ' today' : ''}`}>
            <div className="day-head">
              <span>{WEEKDAYS[day.weekday]}</span>
              <span className="num">{shortDay(day.day)}</span>
            </div>
            <div className="day-body">
              {day.planned.map((p, i) => (
                <div key={`${p.templateId}-${i}`} className={`plan-item${p.doneBy ? ' done' : day.isPast ? ' missed' : ''}`}>
                  <div className="plan-name">{p.name}</div>
                  <div className="plan-meta">
                    <span>{p.kind === 'unknown' ? '' : KIND_LABEL[p.kind]}</span>
                    <span>{p.durationS ? duration(p.durationS) : 'livre'}</span>
                  </div>
                  <div className="plan-state">{p.doneBy ? <a href={href({ name: 'session', id: p.doneBy })}>feito ✓</a> : day.isPast ? 'não feito' : day.isToday ? 'hoje' : ''}</div>
                  {editing && (
                    <button
                      className="plan-remove"
                      aria-label={`Remover ${p.name} de ${WEEKDAYS[day.weekday]}`}
                      onClick={() => void savePlan({ days: d.weekPlan.days.map((ids, w) => (w === day.weekday ? ids.filter((_, k) => k !== i) : ids)) })}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {day.sessions.filter((s) => !day.planned.some((p) => p.doneBy === s.id)).map((s) => (
                <a key={s.id} className="plan-item extra" href={href({ name: 'session', id: s.id })}>
                  <div className="plan-name">{s.workout?.name ?? 'Treino'}</div>
                  <div className="plan-meta"><span>extra</span><span>{duration(s.durationS)}</span></div>
                </a>
              ))}
              {!day.planned.length && !day.sessions.length && !editing && <div className="rest">Descanso</div>}
              {editing && (
                <select
                  className="select"
                  value=""
                  aria-label={`Adicionar treino em ${WEEKDAYS[day.weekday]}`}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) void savePlan({ days: d.weekPlan.days.map((ids, w) => (w === day.weekday ? [...ids, id] : ids)) });
                  }}
                >
                  <option value="">+ adicionar</option>
                  {d.templates.filter((t) => t.id !== 'free').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
