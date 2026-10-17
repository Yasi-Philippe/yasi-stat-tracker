/** Turns theme tokens into CSS variables on <html>. */

import type { ThemeTokens } from '@/core/model/types';
import { fontStack } from './themes';

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** rgba() from a hex colour; passes non-hex colours through unchanged. */
export function alpha(color: string, a: number): string {
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})` : color;
}

/** Relative luminance, for picking readable text on a colour. */
export function luminance(color: string): number {
  const rgb = hexToRgb(color);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function onColor(color: string): string {
  return luminance(color) > 0.45 ? '#0B0B0D' : '#FFFFFF';
}

export function themeVars(t: ThemeTokens): Record<string, string> {
  return {
    '--bg': t.bg,
    '--surface': t.surface,
    '--surface-2': t.surface2,
    '--line': t.line,
    '--text': t.text,
    '--muted': t.muted,
    '--faint': alpha(t.muted, 0.55),
    '--accent': t.accent,
    '--accent-2': t.accent2,
    '--on-accent': onColor(t.accent),
    '--accent-soft': alpha(t.accent, t.scheme === 'dark' ? 0.14 : 0.12),
    '--accent-2-soft': alpha(t.accent2, t.scheme === 'dark' ? 0.16 : 0.12),
    '--positive': t.positive,
    '--negative': t.negative,
    '--positive-soft': alpha(t.positive, 0.14),
    '--negative-soft': alpha(t.negative, 0.14),
    '--font-ui': fontStack(t.fontUI),
    '--font-display': fontStack(t.fontDisplay),
    '--font-number': fontStack(t.fontNumber),
    '--radius': `${t.radius}px`,
    '--radius-sm': `${Math.max(4, Math.round(t.radius * 0.6))}px`,
    '--radius-xs': `${Math.max(3, Math.round(t.radius * 0.38))}px`,
    '--glow': String(t.glow),
    '--glow-accent': t.glow > 0 ? `0 0 ${Math.round(28 * t.glow)}px ${alpha(t.accent, 0.35 * t.glow)}` : 'none',
    '--shadow':
      t.scheme === 'dark'
        ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -18px rgba(0,0,0,0.8)'
        : '0 1px 2px rgba(20,20,40,0.06), 0 10px 30px -18px rgba(20,20,40,0.25)',
  };
}

let onSchemeChange: ((scheme: 'dark' | 'light') => void) | null = null;

/** Lets the shell react to light/dark switches (status bar icon colour on Android). */
export function setSchemeListener(fn: (scheme: 'dark' | 'light') => void): void {
  onSchemeChange = fn;
}

export function applyTheme(t: ThemeTokens, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v);
  root.dataset.scheme = t.scheme;
  root.style.colorScheme = t.scheme;
  root.style.backgroundColor = t.bg;
  onSchemeChange?.(t.scheme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.bg);
}
