/**
 * Reading numbers and dates the way people type them in spreadsheets:
 * "1.234,56 €", "(12.5)", "31/12/2024", Excel serial numbers. The detect
 * functions look at a whole column and trust only real evidence, e.g. a day
 * above 12 to tell DD/MM from MM/DD.
 */

import { daysInMonth, fromDayNum, type ISODate } from '../model/dates';
import { type Cell, isEmptyCell } from './table';

export type DecimalSeparator = '.' | ',';

/** Share of a column's non-empty cells that must fit a reading for it to be trusted. */
const MIN_SHARE = 0.8;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * sign, optional currency prefix ("€", "US$", "EUR") with its own sign,
 * digits with separators, exponent, optional suffix ("%", "€", "kg", "°C", "km/h").
 */
const NUMBER_RE =
  /^([+\-−]?)\s*(?:([A-Z]{0,3}\p{Sc}|[A-Z]{3})\s*([+\-−]?)\s*)?(\d[\d.,'’\s]*|[.,]\d+)(?:[eE]([+-]?\d{1,3}))?\s*(%|‰|\p{Sc}|[A-Z]{3}|°?\p{L}{1,5}(?:\/\p{L}{1,5})?[²³]?)?$/u;
const CURRENCY_RE = /^(?:\p{Sc}|[A-Z]{3})$/u;
const SPACED_GROUPS_RE = /^\d{1,3}(?:[\s'’]\d{3})+(?:[.,]\d*)?$/;
/** "1234", "-80.5", "80,5": the common case, read without the full pattern. */
const PLAIN_RE = /^(-?)(\d+)(?:([.,])(\d+))?$/;
const THOUSANDS_HEAD_RE = /^[1-9]\d{0,2}$/;

interface NumberMatch {
  neg: boolean;
  core: string;
  exp: string;
  /** A currency sits next to the number, so three digits after a separator are thousands. */
  money: boolean;
  unit: string;
}

function matchNumber(text: string): NumberMatch | null {
  let s = text.trim();
  let neg = false;
  if (s.length > 2 && s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  const m = NUMBER_RE.exec(s);
  if (!m) return null;
  const minus = (x: string | undefined) => x === '-' || x === '−';
  const prefix = m[2] ?? '';
  const suffix = m[6] ?? '';
  return {
    neg: neg || minus(m[1]) || minus(m[3]),
    core: m[4]!.trim(),
    exp: m[5] ?? '',
    money: prefix !== '' || CURRENCY_RE.test(suffix),
    unit: suffix || prefix,
  };
}

/** "1.234,5" → "1234.5" given the separators' roles; null if the grouping makes no sense. */
function canonical(core: string, decimal: DecimalSeparator, money: boolean): string | null {
  let s = core;
  if (/[\s'’]/.test(s)) {
    if (!SPACED_GROUPS_RE.test(s)) return null;
    s = s.replace(/[\s'’]/g, '');
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let int = s;
  let frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the last one is the decimal mark.
    const at = Math.max(lastDot, lastComma);
    const dec = s[at]!;
    const thousands = dec === '.' ? ',' : '.';
    int = s.slice(0, at);
    frac = s.slice(at + 1);
    if (int.includes(dec) || !grouped(int, thousands)) return null;
    int = int.split(thousands).join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2) {
      // Repeated: thousands separators.
      if (!grouped(s, sep)) return null;
      int = parts.join('');
    } else {
      const [a, b] = parts as [string, string];
      // "1,234" is a thousand unless the comma is the decimal mark; "80,5" is always a decimal.
      const thousands = b.length === 3 && THOUSANDS_HEAD_RE.test(a) && (sep !== decimal || money);
      int = thousands ? a + b : a;
      frac = thousands ? '' : b;
    }
  }
  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || int + frac === '') return null;
  return `${int || '0'}.${frac || '0'}`;
}

/** Digit groups: 1–3 digits, then groups of 2–3 (Western and Indian styles), the last of exactly 3. */
function grouped(s: string, sep: string): boolean {
  const g = s.split(sep);
  if (!/^\d{1,3}$/.test(g[0]!)) return false;
  for (let i = 1; i < g.length; i++) {
    if (!(i === g.length - 1 ? /^\d{3}$/ : /^\d{2,3}$/).test(g[i]!)) return false;
  }
  return true;
}

/**
 * A number and the unit or currency written next to it ("80.5 kg" → 80.5,
 * "kg"). Spreadsheet numbers pass through; booleans read as 1 and 0.
 */
export function parseNumberParts(
  cell: Cell | undefined,
  hint?: { decimal: DecimalSeparator },
): { value: number; unit: string } | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? { value: cell, unit: '' } : null;
  if (typeof cell === 'boolean') return { value: cell ? 1 : 0, unit: '' };
  if (typeof cell !== 'string') return null;
  const decimal = hint?.decimal ?? '.';
  const plain = PLAIN_RE.exec(cell);
  if (plain) {
    // Same rules as canonical() below, for a lone separator without currency.
    const [, sign, int, sep, frac = ''] = plain;
    const thousands = sep !== undefined && sep !== decimal && frac.length === 3 && THOUSANDS_HEAD_RE.test(int!);
    const n = thousands ? Number(int! + frac) : Number(sep ? `${int}.${frac}` : int);
    return { value: sign && n ? -n : n, unit: '' };
  }
  const m = matchNumber(cell);
  if (!m) return null;
  const c = canonical(m.core, decimal, m.money);
  if (c === null) return null;
  const n = Number(m.exp ? `${c}e${m.exp}` : c);
  if (!Number.isFinite(n)) return null;
  const value = m.neg ? -n : n;
  return { value: value === 0 ? 0 : value, unit: m.unit };
}

/**
 * Reads "80.5", "80,5", "1.234,56", "1,234.56", "1 234,56", "€ 1.200",
 * "1200 €", "$1,200.50", "-12", "(12.5)" → -12.5, "12%" → 12, "80 kg".
 * The hint only matters for a lone separator followed by three digits
 * ("1,234" is 1234 with '.', 1.234 with ','); without one '.' is assumed.
 */
export function parseNumber(cell: Cell | undefined, hint?: { decimal: DecimalSeparator }): number | null {
  return parseNumberParts(cell, hint)?.value ?? null;
}

/** The decimal mark that the text numbers of a column use. '.' when nothing tells. */
export function detectDecimalSeparator(samples: readonly Cell[]): DecimalSeparator {
  let dot = 0;
  let comma = 0;
  const vote = (sep: string) => (sep === '.' ? dot++ : comma++);
  for (const cell of samples) {
    // A lead this large will not turn: stop reading.
    if (Math.abs(dot - comma) >= 1000) break;
    if (typeof cell !== 'string') continue;
    const plain = PLAIN_RE.exec(cell);
    if (plain) {
      const [, , int, sep, frac = ''] = plain;
      if (sep && (frac.length !== 3 || !THOUSANDS_HEAD_RE.test(int!))) vote(sep);
      continue;
    }
    const m = matchNumber(cell);
    if (!m || canonical(m.core, '.', m.money) === null) continue;
    const core = m.core.replace(/[\s'’]/g, '');
    const lastDot = core.lastIndexOf('.');
    const lastComma = core.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      vote(lastDot > lastComma ? '.' : ',');
      continue;
    }
    if (lastDot < 0 && lastComma < 0) continue;
    const sep = lastDot >= 0 ? '.' : ',';
    const other = sep === '.' ? ',' : '.';
    const parts = core.split(sep);
    if (parts.length > 2) vote(other);
    else if (parts[1]!.length !== 3 || !THOUSANDS_HEAD_RE.test(parts[0]!)) vote(sep);
    else if (m.money) vote(other);
    // Otherwise "1,234" could be either: no evidence.
  }
  return comma > dot ? ',' : '.';
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * How the date column is written.
 * - ymd: 2024-12-31, 2024/12/31, 2024.12.31 (a time part after it is ignored)
 * - dmy: 31/12/2024, 31-12-2024, 31.12.2024, 31/12/24
 * - mdy: 12/31/2024, 12/31/24
 * - ym: 2024-12 (read as the 1st of the month)
 * - my: 12/2024 (read as the 1st of the month)
 * - native: date cells of a workbook
 * - serial: Excel serial day numbers (45657 = 2024-12-31)
 * Unambiguous forms are always accepted whatever the format: workbook date
 * cells, 2024-12-31, 2024-12 and 12/2024. The format decides the rest:
 * DD/MM against MM/DD, and plain numbers (only native and serial read them).
 */
export const DATE_FORMATS = ['ymd', 'dmy', 'mdy', 'ym', 'my', 'native', 'serial'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface DateFormatGuess {
  format: DateFormat;
  /** True when no value tells DD/MM from MM/DD (or values disagree): ask the user. */
  ambiguous: boolean;
}

const YMD_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?=$|[T\s])/;
const YM_RE = /^(\d{4})[-/.](\d{1,2})$/;
const MY_RE = /^(\d{1,2})[-/.](\d{4})$/;
const XXY_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?=$|[T\s,])/;
const SERIAL_RE = /^\d{1,7}(?:\.\d+)?$/;

/** Excel serial numbers of 1950-01-01 and 2100-01-01: the range where a plain number is believably a date. */
const PLAUSIBLE_SERIAL_MIN = 18264;
const PLAUSIBLE_SERIAL_MAX = 73051;

type Shape =
  | { kind: 'fixed'; tag: 'ymd' | 'ym' | 'my'; iso: ISODate | null }
  | { kind: 'xxy'; dmy: ISODate | null; mdy: ISODate | null }
  | { kind: 'num'; value: number };

function shapeOf(text: string): Shape | null {
  const s = text.trim();
  let m = YMD_RE.exec(s);
  if (m) return { kind: 'fixed', tag: 'ymd', iso: isoFrom(+m[1]!, +m[2]!, +m[3]!) };
  if ((m = YM_RE.exec(s))) return { kind: 'fixed', tag: 'ym', iso: isoFrom(+m[1]!, +m[2]!, 1) };
  if ((m = MY_RE.exec(s))) return { kind: 'fixed', tag: 'my', iso: isoFrom(+m[2]!, +m[1]!, 1) };
  if ((m = XXY_RE.exec(s))) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = fullYear(m[3]!);
    return { kind: 'xxy', dmy: isoFrom(y, b, a), mdy: isoFrom(y, a, b) };
  }
  if (SERIAL_RE.test(s)) return { kind: 'num', value: Number(s) };
  return null;
}

/** A date in any format, or null. Workbook dates are read in UTC, as the workbook reader creates them. */
export function parseDate(cell: Cell | undefined, format: DateFormat): ISODate | null {
  if (cell instanceof Date) return dateToISO(cell);
  if (typeof cell === 'number') return format === 'serial' || format === 'native' ? serialToISO(cell) : null;
  if (typeof cell !== 'string') return null;
  const shape = shapeOf(cell);
  if (!shape) return null;
  switch (shape.kind) {
    case 'fixed':
      return shape.iso;
    case 'xxy':
      return format === 'dmy' ? shape.dmy : format === 'mdy' ? shape.mdy : null;
    case 'num':
      return format === 'serial' ? serialToISO(shape.value) : null;
  }
}

/** True for anything that reads as a date in some format, except plain numbers. */
export function isDateLike(cell: Cell | undefined): boolean {
  if (cell instanceof Date) return dateToISO(cell) !== null;
  if (typeof cell !== 'string') return false;
  const shape = shapeOf(cell);
  if (shape?.kind === 'fixed') return shape.iso !== null;
  if (shape?.kind === 'xxy') return shape.dmy !== null || shape.mdy !== null;
  return false;
}

/**
 * The format that reads at least 80% of the non-empty samples, or null.
 * DD/MM is preferred when no day is above 12; `ambiguous` then says so.
 * Plain numbers count as dates only between 1950 and 2100.
 */
export function detectDateFormat(samples: readonly Cell[]): DateFormatGuess | null {
  let total = 0;
  let native = 0;
  const fixed = { ymd: 0, ym: 0, my: 0 };
  let both = 0;
  let dmyOnly = 0;
  let mdyOnly = 0;
  let serialNum = 0;
  let serialText = 0;
  // Once this many cells fit no format at all, no format can reach the share: stop early.
  const maxMisses = samples.length * (1 - MIN_SHARE);
  let misses = 0;
  for (const cell of samples) {
    if (isEmptyCell(cell)) continue;
    total++;
    let hit = false;
    if (cell instanceof Date) {
      hit = dateToISO(cell) !== null;
      if (hit) native++;
    } else if (typeof cell === 'number') {
      hit = plausibleSerial(cell);
      if (hit) serialNum++;
    } else if (typeof cell === 'string') {
      const shape = shapeOf(cell);
      hit = true;
      if (shape?.kind === 'fixed' && shape.iso) fixed[shape.tag]++;
      else if (shape?.kind === 'xxy' && shape.dmy && shape.mdy) both++;
      else if (shape?.kind === 'xxy' && shape.dmy) dmyOnly++;
      else if (shape?.kind === 'xxy' && shape.mdy) mdyOnly++;
      else if (shape?.kind === 'num' && plausibleSerial(shape.value)) serialText++;
      else hit = false;
    }
    if (!hit && ++misses > maxMisses) return null;
  }
  if (!total) return null;

  const unambiguous = native + fixed.ymd + fixed.ym + fixed.my;
  // Candidates in tie-break order.
  const candidates: Array<[DateFormat, number]> = [];
  if (both + dmyOnly + mdyOnly > 0) {
    const dmy = unambiguous + both + dmyOnly;
    const mdy = unambiguous + both + mdyOnly;
    candidates.push(mdy > dmy ? ['mdy', mdy] : ['dmy', dmy]);
  }
  if (native > 0) candidates.push(['native', unambiguous + serialNum]);
  if (unambiguous > 0) {
    const tag = fixed.ymd >= fixed.ym && fixed.ymd >= fixed.my ? 'ymd' : fixed.ym >= fixed.my ? 'ym' : 'my';
    candidates.push([tag, unambiguous]);
  }
  if (serialNum + serialText > 0) candidates.push(['serial', unambiguous + serialNum + serialText]);

  let best: [DateFormat, number] | null = null;
  for (const c of candidates) if (!best || c[1] > best[1]) best = c;
  if (!best || best[1] < total * MIN_SHARE) return null;
  const format = best[0];
  const ambiguous = (format === 'dmy' || format === 'mdy') && (dmyOnly === 0) === (mdyOnly === 0);
  return { format, ambiguous };
}

function plausibleSerial(n: number): boolean {
  return n >= PLAUSIBLE_SERIAL_MIN && n < PLAUSIBLE_SERIAL_MAX;
}

/** Excel 1900 date system, including its fictitious 1900-02-29 (serial 60, rejected). */
function serialToISO(serial: number): ISODate | null {
  if (!Number.isFinite(serial)) return null;
  const day = Math.floor(Math.round(serial * 86400) / 86400);
  if (day < 1 || day === 60 || day > 2958465) return null;
  return dayToISO(day < 60 ? day - 25568 : day - 25569);
}

function dateToISO(d: Date): ISODate | null {
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return dayToISO(Math.floor(Math.round(t / 1000) / 86400));
}

function dayToISO(day: number): ISODate | null {
  const iso = fromDayNum(day);
  return /^\d{4}-/.test(iso) && iso >= '1000' ? iso : null;
}

function isoFrom(y: number, m: number, d: number): ISODate | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

const THIS_YEAR = new Date().getFullYear();

/** Two-digit years land within 80 years before and 20 after the current year. */
function fullYear(s: string): number {
  if (s.length === 4) return Number(s);
  let y = Math.floor(THIS_YEAR / 100) * 100 + Number(s);
  if (y > THIS_YEAR + 20) y -= 100;
  else if (y <= THIS_YEAR - 80) y += 100;
  return y;
}
