import { useEffect, useState } from 'react';

/** Hash routes keep the desktop app (custom protocol) and the PWA on one code path. */
export type Route =
  | { readonly name: 'train' }
  | { readonly name: 'week' }
  | { readonly name: 'history' }
  | { readonly name: 'session'; readonly id: string }
  | { readonly name: 'evolution' }
  | { readonly name: 'morning' }
  | { readonly name: 'library' }
  | { readonly name: 'template'; readonly id: string }
  | { readonly name: 'profile' };

export function parseRoute(hash: string): Route {
  const [a = '', b] = hash.replace(/^#\/?/, '').split('/');
  switch (a) {
    case 'semana': return { name: 'week' };
    case 'historico': return b ? { name: 'session', id: decodeURIComponent(b) } : { name: 'history' };
    case 'evolucao': return { name: 'evolution' };
    case 'matinal': return { name: 'morning' };
    case 'treinos': return b ? { name: 'template', id: decodeURIComponent(b) } : { name: 'library' };
    case 'perfil': return { name: 'profile' };
    default: return { name: 'train' };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'train': return '#/treino';
    case 'week': return '#/semana';
    case 'history': return '#/historico';
    case 'session': return `#/historico/${encodeURIComponent(r.id)}`;
    case 'evolution': return '#/evolucao';
    case 'morning': return '#/matinal';
    case 'library': return '#/treinos';
    case 'template': return `#/treinos/${encodeURIComponent(r.id)}`;
    case 'profile': return '#/perfil';
  }
}

export function go(r: Route): void {
  window.location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
