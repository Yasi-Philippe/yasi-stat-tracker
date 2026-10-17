import { describe, expect, it } from 'vitest';
import { scan, tokenize, type ScanToken } from './lexer';
import { ExprError } from './types';

const kinds = (text: string): string[] => tokenize(text).map((t) => `${t.type}:${t.text}`);
const firstError = (text: string): ScanToken | undefined => scan(text).find((t) => t.type === 'error');

function lexError(text: string): ExprError {
  try {
    tokenize(text);
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error(`expected "${text}" to fail`);
}

describe('lexer: numbers', () => {
  it.each([
    ['12', 12],
    ['3.5', 3.5],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['2.5E-3', 0.0025],
    ['1e+2', 100],
    ['1_250_000', 1250000],
    ['1_000.25', 1000.25],
    ['0', 0],
  ])('reads %s', (text, value) => {
    const [t] = tokenize(text);
    expect(t.type).toBe('num');
    expect(t.type === 'num' && t.value).toBe(value);
    expect(t.text).toBe(text);
  });

  it('rejects misplaced digit separators', () => {
    for (const text of ['1_', '1__000', '1_.5', '.5_']) {
      expect(lexError(text).message).toBe(`Invalid number "${text}": "_" can only go between digits, like 1_000`);
    }
  });

  it('rejects letters glued to a number and suggests multiplication', () => {
    const e = lexError('2x + 1');
    expect(e.message).toBe('Invalid number "2x". To multiply, write 2 * x');
    expect(e.span).toEqual({ start: 0, end: 2 });
    expect(lexError('1.2.3').message).toBe('Invalid number "1.2.3"');
    expect(lexError('1e').message).toBe('Invalid number "1e"');
  });

  it('rejects numbers too large to represent', () => {
    expect(lexError('1e999').message).toBe('The number "1e999" is too large');
  });
});

describe('lexer: text, names and operators', () => {
  it('reads double-quoted text, including typographic quotes', () => {
    const [a] = tokenize('"2021-03-01"');
    expect(a).toMatchObject({ type: 'str', value: '2021-03-01', start: 0, end: 12 });
    const [b] = tokenize('“median”');
    expect(b).toMatchObject({ type: 'str', value: 'median' });
  });

  it('reports unterminated text up to the end', () => {
    const e = lexError('since("2021-03-01');
    expect(e.message).toBe('This text has no closing quote (")');
    expect(e.span).toEqual({ start: 6, end: 17 });
  });

  it('asks for double quotes instead of single quotes', () => {
    expect(lexError("rolling(x, 7, 'median')").message).toBe('Use double quotes for text, like "median"');
  });

  it('reads names with digits and underscores', () => {
    expect(kinds('weight_2 _x monthly_need')).toEqual(['ident:weight_2', 'ident:_x', 'ident:monthly_need', 'eof:']);
  });

  it('reports names with letters outside a-z as a whole word', () => {
    const e = lexError('peso_médio * 2');
    expect(e.message).toBe('Invalid name "peso_médio": names can only use the letters a-z and A-Z, digits and "_"');
    expect(e.span).toEqual({ start: 0, end: 10 });
  });

  it('reads every operator, two-character ones first', () => {
    expect(kinds('<= >= == != < > + - * / ^ ( ) ,').slice(0, -1)).toEqual(
      ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '^', '(', ')', ','].map((op) => `op:${op}`),
    );
    expect(kinds('a<=b')).toEqual(['ident:a', 'op:<=', 'ident:b', 'eof:']);
  });

  it('explains "=" and "!" and rejects unknown characters', () => {
    expect(lexError('a = b').message).toBe('Use "==" to check whether two values are equal');
    expect(lexError('!a').message).toBe('Use "!=" to check whether two values are different');
    const e = lexError('a # b');
    expect(e.message).toBe('Unexpected character "#"');
    expect(e.span).toEqual({ start: 2, end: 3 });
    // A character outside the basic plane spans two code units.
    expect(lexError('a \u{1F600}').span).toEqual({ start: 2, end: 4 });
  });

  it('records character offsets and ends with eof', () => {
    const tokens = tokenize('  a +\n12 ');
    expect(tokens.map((t) => [t.start, t.end])).toEqual([
      [2, 3],
      [4, 5],
      [6, 8],
      [9, 9],
    ]);
  });

  it('scan never throws and keeps tokens after an error', () => {
    const tokens = scan('weight # 2');
    expect(tokens.map((t) => t.type)).toEqual(['ident', 'error', 'num', 'eof']);
    expect(firstError('"open')).toMatchObject({ type: 'error', start: 0, end: 5 });
    expect(scan('')).toEqual([{ type: 'eof', text: '', start: 0, end: 0 }]);
  });
});
