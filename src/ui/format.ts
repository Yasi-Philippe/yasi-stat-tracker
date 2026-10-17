/** Number, date and relative-time formatting in the user's locale. */

import { type DayNum, dayNumToMs, fromDayNum, toDayNum } from '@/core/model/dates';

let locale: string | undefined;

export function setLocale(l: string | undefined): void {
  locale = l || undefined;
  numberFormats.clear();
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function nf(decimals: number, compact = false, sign = false): Intl.NumberFormat {
  const key = `${decimals}|${compact}|${sign}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      minimumFractionDigits: compact ? 0 : decimals,
      maximumFractionDigits: compact ? Math.min(decimals, 1) : decimals,
      notation: compact ? 'compact' : 'standard',
      signDisplay: sign ? 'exceptZero' : 'auto',
    });
    numberFormats.set(key, f);
  }
  return f;
}

export function fmtNum(v: number | null | undefined, decimals = 1, opts: { compact?: boolean; sign?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return nf(decimals, opts.compact, opts.sign).format(v).replace('-', '−');
}

/** "72.4 kg", "1,250 €", "34.2 %". Currency-like units stick to the number. */
export function fmtValue(v: number | null | undefined, unit: string, decimals = 1, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const n = fmtNum(v, decimals, opts);
  if (!unit || n === '—') return n;
  if (unit === '%') return `${n}%`;
  return `${n} ${unit}`;
}

/** Splits a formatted number for typographic treatment of the decimals. */
export function splitNumber(s: string): { int: string; frac: string } {
  const m = /^(.*?)([.,]\d+)?$/.exec(s);
  return { int: m?.[1] ?? s, frac: m?.[2] ?? '' };
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function df(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
    dateFormats.set(key, f);
  }
  return f;
}

export function fmtDay(day: DayNum | string, style: 'long' | 'medium' | 'short' | 'weekday' | 'month' | 'year' | 'monthShort' = 'medium'): string {
  const d = new Date(dayNumToMs(typeof day === 'string' ? toDayNum(day) : day));
  switch (style) {
    case 'long':
      return df({ weekday: 'long', day: 'numeric', month: 'long' }).format(d);
    case 'weekday':
      return df({ weekday: 'short' }).format(d);
    case 'short':
      return df({ day: 'numeric', month: 'short' }).format(d);
    case 'month':
      return df({ month: 'long', year: 'numeric' }).format(d);
    case 'monthShort':
      return df({ month: 'short', year: '2-digit' }).format(d);
    case 'year':
      return df({ year: 'numeric' }).format(d);
    default:
      return df({ day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
}

export function relativeDay(day: DayNum, today: DayNum): string {
  const diff = today - day;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return fmtDay(day, 'weekday');
  return fmtDay(day, diff < 300 ? 'short' : 'medium');
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

export function isoToday(): string {
  const n = new Date();
  return fromDayNum(Math.round(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 86_400_000));
}

/** Parses what a person types: "72,4", "1 250.5", "−3". */
export function parseInput(s: string): number | null {
  const t = s.trim().replace(/\s/g, '').replace('−', '-');
  if (!t) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let norm = t;
  if (lastComma > lastDot) norm = t.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma && lastComma >= 0) norm = t.replace(/,/g, '');
  const v = Number(norm);
  return Number.isFinite(v) ? v : null;
}
