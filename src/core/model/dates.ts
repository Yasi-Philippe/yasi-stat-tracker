/**
 * Calendar helpers. Every date in the app is a local calendar day with no time
 * zone, stored as 'YYYY-MM-DD' (ISODate) or as a DayNum: whole days since
 * 1970-01-01. DayNum arithmetic is exact because it never touches local time.
 */

export type ISODate = string;
export type DayNum = number;

export const MS_PER_DAY = 86_400_000;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function toDayNum(iso: ISODate): DayNum {
  if (!isISODate(iso)) throw new RangeError(`Invalid date "${iso}" (expected YYYY-MM-DD)`);
  const [y, mo, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, mo - 1, d) / MS_PER_DAY);
}

export function fromDayNum(n: DayNum): ISODate {
  const dt = new Date(n * MS_PER_DAY);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** UTC-midnight timestamp of a day, for chart axes that want milliseconds. */
export function dayNumToMs(n: DayNum): number {
  return n * MS_PER_DAY;
}

export function msToDayNum(ms: number): DayNum {
  return Math.floor(ms / MS_PER_DAY);
}

/** The user's current local calendar day. */
export function todayDayNum(now: Date = new Date()): DayNum {
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
}

export function todayISO(now: Date = new Date()): ISODate {
  return fromDayNum(todayDayNum(now));
}

export function ymd(n: DayNum): { y: number; m: number; d: number } {
  const dt = new Date(n * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function fromYMD(y: number, m: number, d: number): DayNum {
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekday(n: DayNum): number {
  return mod(n + 4, 7);
}

/** Monday of the ISO week containing n. */
export function weekStart(n: DayNum): DayNum {
  return n - mod(n + 3, 7);
}

export function monthStart(n: DayNum): DayNum {
  const { y, m } = ymd(n);
  return fromYMD(y, m, 1);
}

export function monthEnd(n: DayNum): DayNum {
  const { y, m } = ymd(n);
  return fromYMD(y, m + 1, 1) - 1;
}

export function quarterStart(n: DayNum): DayNum {
  const { y, m } = ymd(n);
  return fromYMD(y, m - ((m - 1) % 3), 1);
}

export function yearStart(n: DayNum): DayNum {
  return fromYMD(ymd(n).y, 1, 1);
}

export function yearEnd(n: DayNum): DayNum {
  return fromYMD(ymd(n).y + 1, 1, 1) - 1;
}

export function addMonths(n: DayNum, k: number): DayNum {
  const { y, m, d } = ymd(n);
  const target = fromYMD(y, m + k, 1);
  const last = monthEnd(target);
  return Math.min(target + d - 1, last);
}

export function daysInMonth(y: number, m: number): number {
  return fromYMD(y, m + 1, 1) - fromYMD(y, m, 1);
}

/** 'YYYY-MM' */
export function monthKey(n: DayNum): string {
  const { y, m } = ymd(n);
  return `${String(y).padStart(4, '0')}-${pad2(m)}`;
}

function pad2(v: number): string {
  return v < 10 ? `0${v}` : String(v);
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
