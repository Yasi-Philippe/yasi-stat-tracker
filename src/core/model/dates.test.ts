import { describe, expect, it } from 'vitest';
import {
  addMonths,
  daysInMonth,
  fromDayNum,
  isISODate,
  monthEnd,
  monthKey,
  monthStart,
  quarterStart,
  toDayNum,
  todayDayNum,
  weekStart,
  weekday,
  yearEnd,
  yearStart,
} from './dates';

describe('dates', () => {
  it('round-trips ISO dates through day numbers', () => {
    expect(toDayNum('1970-01-01')).toBe(0);
    expect(toDayNum('1969-12-31')).toBe(-1);
    for (const iso of ['2000-02-29', '2024-12-31', '2026-10-11', '1999-01-01']) {
      expect(fromDayNum(toDayNum(iso))).toBe(iso);
    }
  });

  it('rejects impossible dates', () => {
    expect(isISODate('2023-02-29')).toBe(false);
    expect(isISODate('2024-02-29')).toBe(true);
    expect(isISODate('2024-13-01')).toBe(false);
    expect(isISODate('2024-1-01')).toBe(false);
    expect(() => toDayNum('nope')).toThrow(RangeError);
  });

  it('computes weekdays and ISO week starts', () => {
    expect(weekday(0)).toBe(4); // Thursday
    const sunday = toDayNum('2026-10-11');
    expect(weekday(sunday)).toBe(0);
    expect(fromDayNum(weekStart(sunday))).toBe('2026-10-05');
    expect(fromDayNum(weekStart(toDayNum('2026-10-05')))).toBe('2026-10-05');
    expect(fromDayNum(weekStart(-1))).toBe('1969-12-29');
  });

  it('computes month, quarter and year boundaries', () => {
    const d = toDayNum('2024-02-17');
    expect(fromDayNum(monthStart(d))).toBe('2024-02-01');
    expect(fromDayNum(monthEnd(d))).toBe('2024-02-29');
    expect(fromDayNum(quarterStart(toDayNum('2024-05-30')))).toBe('2024-04-01');
    expect(fromDayNum(yearStart(d))).toBe('2024-01-01');
    expect(fromDayNum(yearEnd(d))).toBe('2024-12-31');
    expect(monthKey(d)).toBe('2024-02');
    expect(daysInMonth(2023, 2)).toBe(28);
  });

  it('adds months clamping to the end of shorter months', () => {
    expect(fromDayNum(addMonths(toDayNum('2024-01-31'), 1))).toBe('2024-02-29');
    expect(fromDayNum(addMonths(toDayNum('2024-03-15'), -3))).toBe('2023-12-15');
  });

  it('uses the local calendar day for today', () => {
    const now = new Date(2026, 9, 11, 23, 59);
    expect(fromDayNum(todayDayNum(now))).toBe('2026-10-11');
  });
});
