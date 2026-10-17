import { describe, expect, it } from 'vitest';
import {
  detectDateFormat,
  detectDecimalSeparator,
  isDateLike,
  parseDate,
  parseNumber,
  parseNumberParts,
} from './parse';
import type { Cell } from './table';

describe('parseNumber', () => {
  it('reads the usual ways of writing numbers', () => {
    const cases: Array<[string, number]> = [
      ['80.5', 80.5],
      ['80,5', 80.5],
      ['1.234,56', 1234.56],
      ['1,234.56', 1234.56],
      ['1 234,56', 1234.56],
      ['1 234,56', 1234.56],
      ["1'234.56", 1234.56],
      ['€ 1.200', 1200],
      ['1200 €', 1200],
      ['1.200,50 EUR', 1200.5],
      ['$1,200.50', 1200.5],
      ['R$ 1.200,50', 1200.5],
      ['-12', -12],
      ['−12', -12],
      ['+7', 7],
      ['(12.5)', -12.5],
      ['($1,200)', -1200],
      ['-€12', -12],
      ['€-12', -12],
      ['12%', 12],
      ['12 %', 12],
      ['80.5 kg', 80.5],
      ['36,6°C', 36.6],
      ['12 km/h', 12],
      ['1.234.567', 1234567],
      ['1,234,567', 1234567],
      ['12,34,567.89', 1234567.89],
      ['.5', 0.5],
      [',5', 0.5],
      ['0,123', 0.123],
      ['1234,567', 1234.567],
      ['1.5E+3', 1500],
      ['2e-3', 0.002],
      ['-0', 0],
    ];
    for (const [text, value] of cases) expect(parseNumber(text), text).toBe(value);
  });

  it('uses the hint only for a lone separator followed by three digits', () => {
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('1.234')).toBe(1.234);
    expect(parseNumber('1,234', { decimal: ',' })).toBe(1.234);
    expect(parseNumber('1.234', { decimal: ',' })).toBe(1234);
    expect(parseNumber('80.5', { decimal: ',' })).toBe(80.5);
    expect(parseNumber('80,5', { decimal: '.' })).toBe(80.5);
  });

  it('passes spreadsheet numbers through and reads booleans as 1 and 0', () => {
    expect(parseNumber(80.25)).toBe(80.25);
    expect(parseNumber(true)).toBe(1);
    expect(parseNumber(false)).toBe(0);
    expect(parseNumber(Number.NaN)).toBeNull();
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber(new Date())).toBeNull();
  });

  it('rejects text that is not one number', () => {
    for (const text of ['', ' ', 'abc', 'abc12', 'N/A', '-', '--5', '2024-01-05', '05/01/2024', '01.02.2024', '12:30', '1.2.3', '1,23.4', '12 34', '1-2', '5 kg 300 g']) {
      expect(parseNumber(text), text).toBeNull();
    }
  });

  it('reports the unit or currency written next to the number', () => {
    expect(parseNumberParts('80.5 kg')).toEqual({ value: 80.5, unit: 'kg' });
    expect(parseNumberParts('€ 1.200')).toEqual({ value: 1200, unit: '€' });
    expect(parseNumberParts('12%')).toEqual({ value: 12, unit: '%' });
    expect(parseNumberParts('42')).toEqual({ value: 42, unit: '' });
  });
});

describe('detectDecimalSeparator', () => {
  it('follows the evidence and ignores numbers that could be either', () => {
    expect(detectDecimalSeparator(['80,5', '81', '1.234,5'])).toBe(',');
    expect(detectDecimalSeparator(['80.5', '1,234.5'])).toBe('.');
    expect(detectDecimalSeparator(['1.234.567'])).toBe(',');
    expect(detectDecimalSeparator(['€ 1.200'])).toBe(',');
    expect(detectDecimalSeparator(['1,234', '1.234', '12', 80.5])).toBe('.');
    expect(detectDecimalSeparator(['01.02.2024', '02.02.2024', '3,5'])).toBe(',');
  });
});

describe('parseDate', () => {
  it('reads every format', () => {
    expect(parseDate('2024-03-07', 'ymd')).toBe('2024-03-07');
    expect(parseDate('2024-3-7', 'ymd')).toBe('2024-03-07');
    expect(parseDate('2024-03-07T23:30:00Z', 'ymd')).toBe('2024-03-07');
    expect(parseDate('2024-03-07 08:15', 'ymd')).toBe('2024-03-07');
    expect(parseDate('2024/03/07', 'ymd')).toBe('2024-03-07');
    expect(parseDate('07/03/2024', 'dmy')).toBe('2024-03-07');
    expect(parseDate('07-03-2024', 'dmy')).toBe('2024-03-07');
    expect(parseDate('07.03.2024', 'dmy')).toBe('2024-03-07');
    expect(parseDate('7/3/24', 'dmy')).toBe('2024-03-07');
    expect(parseDate('07/03/2024 10:30', 'dmy')).toBe('2024-03-07');
    expect(parseDate('03/07/2024', 'mdy')).toBe('2024-03-07');
    expect(parseDate('3/7/95', 'mdy')).toBe('1995-03-07');
    expect(parseDate('2024-03', 'ym')).toBe('2024-03-01');
    expect(parseDate('03/2024', 'my')).toBe('2024-03-01');
    expect(parseDate('3.2024', 'my')).toBe('2024-03-01');
  });

  it('reads Excel serial numbers with the 1900 leap-year bug', () => {
    expect(parseDate(1, 'serial')).toBe('1900-01-01');
    expect(parseDate(59, 'serial')).toBe('1900-02-28');
    expect(parseDate(60, 'serial')).toBeNull(); // 1900-02-29 never existed
    expect(parseDate(61, 'serial')).toBe('1900-03-01');
    expect(parseDate(25569, 'serial')).toBe('1970-01-01');
    expect(parseDate(45292, 'serial')).toBe('2024-01-01');
    expect(parseDate(45292.99, 'serial')).toBe('2024-01-01');
    expect(parseDate(45292.9999999999, 'serial')).toBe('2024-01-02');
    expect(parseDate('45292', 'serial')).toBe('2024-01-01');
    expect(parseDate(45292, 'native')).toBe('2024-01-01');
    expect(parseDate(0, 'serial')).toBeNull();
    expect(parseDate(-5, 'serial')).toBeNull();
  });

  it('reads workbook dates in UTC', () => {
    expect(parseDate(new Date('2024-01-03T00:00:00Z'), 'native')).toBe('2024-01-03');
    expect(parseDate(new Date('2024-01-03T18:00:00Z'), 'dmy')).toBe('2024-01-03');
    expect(parseDate(new Date(Number.NaN), 'native')).toBeNull();
  });

  it('always accepts unambiguous forms and lets the format decide the rest', () => {
    expect(parseDate('2024-03-07', 'dmy')).toBe('2024-03-07');
    expect(parseDate('2024-03', 'mdy')).toBe('2024-03-01');
    expect(parseDate('07/03/2024', 'ymd')).toBeNull();
    expect(parseDate('45292', 'dmy')).toBeNull();
    expect(parseDate(45292, 'dmy')).toBeNull();
  });

  it('rejects impossible dates and junk', () => {
    for (const text of ['31/02/2024', '2023-02-29', '2024-13-01', '00/01/2024', '0999-01-01', 'Total', '', '2024-01-05x']) {
      expect(parseDate(text, 'dmy'), text).toBeNull();
    }
    expect(parseDate('2024-02-29', 'ymd')).toBe('2024-02-29');
    expect(parseDate(true, 'native')).toBeNull();
    expect(parseDate(null, 'native')).toBeNull();
  });
});

describe('detectDateFormat', () => {
  const days = (fmt: (d: number) => string, n = 20) => Array.from({ length: n }, (_, i) => fmt(i + 1));

  it('uses days above 12 to tell DD/MM from MM/DD', () => {
    expect(detectDateFormat(days((d) => `${d}/03/2024`))).toEqual({ format: 'dmy', ambiguous: false });
    expect(detectDateFormat(days((d) => `03/${d}/2024`))).toEqual({ format: 'mdy', ambiguous: false });
  });

  it('defaults to DD/MM and flags the ambiguity when nothing tells', () => {
    expect(detectDateFormat(['01/02/2024', '01/03/2024', '01/04/2024'])).toEqual({ format: 'dmy', ambiguous: true });
    // Contradicting values: ask as well.
    const mixed = ['13/01/2024', '01/13/2024', ...days((d) => `0${d}/02/2024`, 8)];
    expect(detectDateFormat(mixed)).toEqual({ format: 'dmy', ambiguous: true });
    // Too contradictory to trust either reading.
    expect(detectDateFormat(['13/01/2024', '01/13/2024', '13/02/2024'])).toBeNull();
  });

  it('recognises the other formats', () => {
    expect(detectDateFormat(['2024-01-01', '2024-01-02T10:00'])).toEqual({ format: 'ymd', ambiguous: false });
    expect(detectDateFormat(['2024-01', '2024-02'])).toEqual({ format: 'ym', ambiguous: false });
    expect(detectDateFormat(['01/2024', '02/2024'])).toEqual({ format: 'my', ambiguous: false });
    expect(detectDateFormat([new Date('2024-01-01T00:00:00Z'), 45293])).toEqual({ format: 'native', ambiguous: false });
    expect(detectDateFormat([45292, 45293, '45294'])).toEqual({ format: 'serial', ambiguous: false });
  });

  it('tolerates a few junk cells but not a column of other things', () => {
    const cells: Cell[] = [...days((d) => `2024-01-${String(d).padStart(2, '0')}`, 10), 'Total', null, ''];
    expect(detectDateFormat(cells)?.format).toBe('ymd');
    expect(detectDateFormat([80.5, 81, 79.9])).toBeNull();
    expect(detectDateFormat(['run', 'gym', '2024-01-01'])).toBeNull();
    expect(detectDateFormat([null, ''])).toBeNull();
  });
});

describe('isDateLike', () => {
  it('accepts written dates and date cells but not plain numbers', () => {
    expect(isDateLike('31/12/2024')).toBe(true);
    expect(isDateLike('2024-12')).toBe(true);
    expect(isDateLike(new Date())).toBe(true);
    expect(isDateLike('45292')).toBe(false);
    expect(isDateLike(45292)).toBe(false);
    expect(isDateLike('Weight')).toBe(false);
  });
});
