import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { customThemes, dataSource, settings as readSettings } from '@/core/data/repo';
import { Workspace } from '@/core/engine';
import type { DataSource } from '@/core/engine/types';
import { type DayNum, todayDayNum } from '@/core/model/dates';
import type { Settings, ThemeDef } from '@/core/model/types';
import type { Vault } from '@/core/vault/vault';
import { platform } from '@/platform';
import { BUILT_IN_THEMES, DEFAULT_THEME } from '@/ui/theme/themes';
import { session, type SessionSnapshot } from './session';

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

const noop = () => () => {};

/** Re-renders whenever anything in the vault changes. */
export function useVault(): { vault: Vault; version: number } {
  const vault = session.vault!;
  const version = useSyncExternalStore(vault ? vault.subscribe : noop, () => vault?.version ?? 0);
  return { vault, version };
}

/** The current local day; ticks over at midnight. */
export function useToday(): DayNum {
  const [today, setToday] = useState(() => todayDayNum());
  useEffect(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const t = setTimeout(() => setToday(todayDayNum()), next.getTime() - now.getTime());
    const onVisible = () => document.visibilityState === 'visible' && setToday(todayDayNum());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [today]);
  return today;
}

/** Engine workspace for the current vault state (memoised per change). */
export function useWorkspace(): { ws: Workspace; src: DataSource; today: DayNum } {
  const { vault, version } = useVault();
  const today = useToday();
  return useMemo(() => {
    const src = dataSource(vault, today);
    return { ws: new Workspace(src), src, today };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, version, today]);
}

export function useSettings(): Settings {
  const { vault, version } = useVault();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readSettings(vault), [vault, version]);
}

export function allThemes(vault: Vault | null): ThemeDef[] {
  return [...BUILT_IN_THEMES, ...(vault ? customThemes(vault) : [])];
}

export function useTheme(): ThemeDef {
  const { vault, version } = useVault();
  const s = useSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => allThemes(vault).find((t) => t.id === s.themeId) ?? DEFAULT_THEME, [vault, version, s.themeId]);
}

/** Handles the Android back button while mounted (e.g. closing a sheet). */
export function useBackHandler(active: boolean, handler: () => void): void {
  useEffect(() => {
    if (!active) return;
    return platform().onBack(() => {
      handler();
      return true;
    });
  }, [active, handler]);
}

export function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = () => setMatch(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [q]);
  return match;
}
