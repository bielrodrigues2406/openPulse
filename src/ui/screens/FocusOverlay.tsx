import { useEffect } from 'react';
import { describeTarget } from '../../domain/workouts/workout';
import { ZONE_COLOR, ZONE_HINT, ZONE_LABEL } from '../components/ui';
import { clock, fmt } from '../format';
import { useLive } from '../services';
import { TargetBadge, alphaNote } from './TrainScreen';

/** Big numbers readable from the saddle. Esc or F to leave. */
export function FocusOverlay({ onClose }: { onClose: () => void }) {
  const s = useLive();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);
  const w = s.workout;
  if (!w) return null;
  const pos = w.position;
  const breath = s.inertial && s.inertial.breathConfidence >= 0.3 ? s.inertial.breathsPerMin : null;
  const rpm = s.inertial && s.inertial.rpmConfidence >= 0.5 ? s.inertial.rpm : null;

  return (
    <div className="focus" onDoubleClick={onClose}>
      <div className="focus-top">
        <span>{w.name}</span>
        <span className="num">{clock(w.activeS)}</span>
        <button className="btn quiet" onClick={onClose}>Sair <kbd>Esc</kbd></button>
      </div>
      <div className="focus-main">
        <div className="focus-hr">
          <div className="focus-value num" style={{ color: s.zone ? ZONE_COLOR[s.zone] : undefined }}>{fmt(s.bpm)}</div>
          <div className="focus-label">
            {s.zone ? `${ZONE_LABEL[s.zone]} · ${ZONE_HINT[s.zone]}` : 'bpm'}
          </div>
        </div>
        {pos && (
          <div className="focus-phase">
            <div className="focus-label">{pos.phase.name}</div>
            <div className="focus-value num small">{clock(pos.phaseRemainingS)}</div>
            <div className="focus-label">{describeTarget(pos.phase.target)} <TargetBadge state={w.target} /></div>
          </div>
        )}
      </div>
      <div className="focus-row">
        <div><span>α1</span><b className="num" style={{ color: 'var(--sig-dfa)' }}>{fmt(s.dfa?.alpha1 ?? null, 2)}</b><em>{alphaNote(s.dfa)}</em></div>
        <div><span>Respiração</span><b className="num" style={{ color: 'var(--sig-breath)' }}>{fmt(breath)}</b><em>irpm · est.</em></div>
        <div><span>Cadência</span><b className="num" style={{ color: 'var(--sig-cadence)' }}>{fmt(rpm)}</b><em>rpm · est.</em></div>
        <div><span>Estado</span><b style={{ fontSize: 22 }}>{w.state === 'running' ? 'Gravando' : 'Pausado'}</b><em>{w.markers === 1 ? '1 volta' : `${w.markers} voltas`}</em></div>
      </div>
    </div>
  );
}
