import { useEffect, useState, type ReactNode } from 'react';
import { SensorCard } from './components/SensorCard';
import { IconHistory, IconLibrary, IconPulse, IconSunrise, IconTrend, IconUser, IconWeek } from './icons';
import { href, useRoute, type Route } from './router';
import { useLive } from './services';
import { TrainScreen } from './screens/TrainScreen';
import { WeekScreen } from './screens/WeekScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { SessionDetail } from './screens/SessionDetail';
import { EvolutionScreen } from './screens/EvolutionScreen';
import { MorningScreen } from './screens/MorningScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { TemplateEditor } from './screens/TemplateEditor';
import { ProfileScreen } from './screens/ProfileScreen';

const NAV: readonly { route: Route; label: string; short: string; icon: (p: object) => ReactNode }[] = [
  { route: { name: 'train' }, label: 'Treino', short: 'Treino', icon: IconPulse },
  { route: { name: 'week' }, label: 'Semana', short: 'Semana', icon: IconWeek },
  { route: { name: 'history' }, label: 'Histórico', short: 'Histórico', icon: IconHistory },
  { route: { name: 'evolution' }, label: 'Evolução', short: 'Evolução', icon: IconTrend },
  { route: { name: 'morning' }, label: 'Teste matinal', short: 'Matinal', icon: IconSunrise },
  { route: { name: 'library' }, label: 'Treinos', short: 'Treinos', icon: IconLibrary },
  { route: { name: 'profile' }, label: 'Perfil', short: 'Perfil', icon: IconUser },
];

function section(r: Route): Route['name'] {
  if (r.name === 'session') return 'history';
  if (r.name === 'template') return 'library';
  return r.name;
}

export function App({ toastText }: { toastText: string | null }) {
  const route = useRoute();
  const live = useLive();
  const recording = live.workout !== null;
  const current = section(route);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <IconPulse width={22} height={22} /> openPulse
        </div>
        <nav className="nav" aria-label="Seções">
          {NAV.map((n) => (
            <a key={n.route.name} href={href(n.route)} aria-current={current === n.route.name ? 'page' : undefined}>
              {n.icon({})}
              {n.label}
              {n.route.name === 'train' && recording && <span className="live-dot" title="Gravando" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <SensorCard />
        </div>
      </aside>

      <header className="topbar">
        <div className="brand">
          <IconPulse width={20} height={20} /> openPulse
        </div>
        <SensorCard compact />
      </header>

      <main className="main">
        <Screen route={route} />
      </main>

      <nav className="tabbar" aria-label="Seções">
        {NAV.map((n) => (
          <a key={n.route.name} href={href(n.route)} aria-current={current === n.route.name ? 'page' : undefined}>
            {n.icon({ width: 22, height: 22 })}
            {n.short}
          </a>
        ))}
      </nav>
      {toastText && <div className="toast" role="status">{toastText}</div>}
    </div>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'train': return <TrainScreen />;
    case 'week': return <WeekScreen />;
    case 'history': return <HistoryScreen />;
    case 'session': return <SessionDetail id={route.id} />;
    case 'evolution': return <EvolutionScreen />;
    case 'morning': return <MorningScreen />;
    case 'library': return <LibraryScreen />;
    case 'template': return <TemplateEditor id={route.id} />;
    case 'profile': return <ProfileScreen />;
  }
}

/** Shows text for 2.6 s. */
export function useToast(): [string | null, (t: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    const id = setTimeout(() => setText(null), 2600);
    return () => clearTimeout(id);
  }, [text]);
  return [text, setText];
}
