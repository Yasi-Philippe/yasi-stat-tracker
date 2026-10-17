/** A tiny hash router: '#/today', '#/charts/<dashboardId>', '#/chart/<id>', … */

import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'today' }
  | { name: 'charts'; dashboardId?: string }
  | { name: 'chart'; id: string }
  | { name: 'metric'; id: string }
  | { name: 'studio'; section?: StudioSection; id?: string }
  | { name: 'settings'; section?: string };

export type StudioSection = 'metrics' | 'formulas' | 'periods' | 'charts' | 'dashboards' | 'themes' | 'templates' | 'import';

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'charts':
      return { name: 'charts', dashboardId: parts[1] };
    case 'chart':
      return parts[1] ? { name: 'chart', id: parts[1] } : { name: 'charts' };
    case 'metric':
      return parts[1] ? { name: 'metric', id: parts[1] } : { name: 'today' };
    case 'studio':
      return { name: 'studio', section: parts[1] as StudioSection | undefined, id: parts[2] };
    case 'settings':
      return { name: 'settings', section: parts[1] };
    default:
      return { name: 'today' };
  }
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'today':
      return '#/today';
    case 'charts':
      return r.dashboardId ? `#/charts/${encodeURIComponent(r.dashboardId)}` : '#/charts';
    case 'chart':
      return `#/chart/${encodeURIComponent(r.id)}`;
    case 'metric':
      return `#/metric/${encodeURIComponent(r.id)}`;
    case 'studio':
      return ['#/studio', r.section, r.id].filter(Boolean).map(String).join('/');
    case 'settings':
      return r.section ? `#/settings/${r.section}` : '#/settings';
  }
}

export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const path = routePath(r);
  if (location.hash === path) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function back(fallback: Route = { name: 'today' }): void {
  if (history.state !== null || history.length > 1) history.back();
  else navigate(fallback, { replace: true });
}

let cached = typeof location !== 'undefined' ? parseRoute(location.hash) : ({ name: 'today' } as Route);
let cachedHash = typeof location !== 'undefined' ? location.hash : '';

function subscribe(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  window.addEventListener('popstate', fn);
  return () => {
    window.removeEventListener('hashchange', fn);
    window.removeEventListener('popstate', fn);
  };
}

function snapshot(): Route {
  if (location.hash !== cachedHash) {
    cachedHash = location.hash;
    cached = parseRoute(location.hash);
  }
  return cached;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}
