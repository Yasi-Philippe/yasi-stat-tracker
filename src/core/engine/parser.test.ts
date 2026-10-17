import { describe, expect, it } from 'vitest';
import { parse, type Node } from './parser';
import { ExprError } from './types';

/** Compact prefix notation, to check the tree shape. */
function show(n: Node): string {
  switch (n.type) {
    case 'num':
      return String(n.value);
    case 'str':
      return JSON.stringify(n.value);
    case 'ident':
      return n.name;
    case 'neg':
      return `(neg ${show(n.arg)})`;
    case 'binary':
      return `(${n.op} ${show(n.left)} ${show(n.right)})`;
    case 'call':
      return `(${n.name}${n.args.map((a) => ` ${show(a)}`).join('')})`;
  }
}

function parseError(text: string): ExprError {
  try {
    parse(text);
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error(`expected "${text}" to fail`);
}

describe('parser: precedence and associativity', () => {
  it.each([
    ['1 + 2 * 3', '(+ 1 (* 2 3))'],
    ['(1 + 2) * 3', '(* (+ 1 2) 3)'],
    ['1 - 2 - 3', '(- (- 1 2) 3)'],
    ['8 / 4 / 2', '(/ (/ 8 4) 2)'],
    ['2 ^ 3 ^ 2', '(^ 2 (^ 3 2))'],
    ['-2 ^ 2', '(neg (^ 2 2))'],
    ['2 ^ -1', '(^ 2 (neg 1))'],
    ['-a * b', '(* (neg a) b)'],
    ['--a', '(neg (neg a))'],
    ['+a', 'a'],
    ['a < b + 1', '(< a (+ b 1))'],
    ['a * b == c - d', '(== (* a b) (- c d))'],
    ['a / b ^ 2 * c', '(* (/ a (^ b 2)) c)'],
    ['weight / (height / 100) ^ 2', '(/ weight (^ (/ height 100) 2))'],
    ['(a < b) * (b < c)', '(* (< a b) (< b c))'],
    ['(a < b) < c', '(< (< a b) c)'],
  ])('%s', (text, tree) => {
    expect(show(parse(text))).toBe(tree);
  });

  it('parses calls with any number of arguments', () => {
    expect(show(parse('rolling(weight, 7, "median")'))).toBe('(rolling weight 7 "median")');
    expect(show(parse('f()'))).toBe('(f)');
    expect(show(parse('max(a, min(b, 3), -c)'))).toBe('(max a (min b 3) (neg c))');
    expect(show(parse('pct(stocks,1000)*2'))).toBe('(* (pct stocks 1000) 2)');
  });

  it('accepts whitespace and line breaks anywhere between tokens', () => {
    expect(show(parse('\n  networth\n  / 12\t'))).toBe('(/ networth 12)');
  });
});

describe('parser: spans', () => {
  it('records the source range of every node', () => {
    const n = parse('abs(x) + 1');
    expect(n.span).toEqual({ start: 0, end: 10 });
    if (n.type !== 'binary') throw new Error('expected a binary node');
    expect(n.opSpan).toEqual({ start: 7, end: 8 });
    expect(n.left.span).toEqual({ start: 0, end: 6 });
    if (n.left.type !== 'call') throw new Error('expected a call');
    expect(n.left.nameSpan).toEqual({ start: 0, end: 3 });
    expect(n.left.args[0].span).toEqual({ start: 4, end: 5 });
    expect(n.right.span).toEqual({ start: 9, end: 10 });
  });

  it('includes parentheses in the span and marks the node', () => {
    const n = parse('(a + b) * c');
    if (n.type !== 'binary') throw new Error('expected a binary node');
    expect(n.left.span).toEqual({ start: 0, end: 7 });
    expect(n.left.parens).toBe(true);
    expect(parse('-x').span).toEqual({ start: 0, end: 2 });
  });
});

describe('parser: errors', () => {
  it.each([
    ['', 'The formula is empty', null],
    ['   ', 'The formula is empty', null],
    ['rolling(x, 3', 'Expected ")" to close "rolling("', { start: 0, end: 8 }],
    ['rolling(x,', 'Expected ")" to close "rolling("', { start: 0, end: 8 }],
    ['1 + max(', 'Expected ")" to close "max("', { start: 4, end: 8 }],
    ['(a + b', 'Expected ")" to close "("', { start: 0, end: 1 }],
    ['a +', 'Expected a value after "+"', { start: 2, end: 3 }],
    ['a + * b', 'Expected a value after "+", but found "*"', { start: 4, end: 5 }],
    ['* 2', 'Expected a value, but found "*"', { start: 0, end: 1 }],
    ['max(a,)', 'Expected a value after ",", but found ")"', { start: 6, end: 7 }],
    ['()', 'Expected a value after "(", but found ")"', { start: 1, end: 2 }],
    ['a b', 'Unexpected "b". Is an operator missing before it?', { start: 2, end: 3 }],
    ['(a b)', 'Unexpected "b". Is an operator missing before it?', { start: 3, end: 4 }],
    ['a)', 'Unexpected ")": there is no "(" to close', { start: 1, end: 2 }],
    ['a, b', 'Unexpected ",": commas only separate the arguments of a function', { start: 1, end: 2 }],
    ['rolling(x 3)', 'Expected "," or ")" in "rolling(", but found "3"', { start: 10, end: 11 }],
    [
      '1 < x < 3',
      "Comparisons can't be chained. To require both, multiply them: (a < b) * (b < c)",
      { start: 0, end: 7 },
    ],
  ])('%j', (text, message, span) => {
    const e = parseError(text);
    expect(e.message).toBe(message);
    expect(e.span).toEqual(span);
  });

  it('reports lexer errors with their span', () => {
    const e = parseError('weight = 80');
    expect(e.message).toBe('Use "==" to check whether two values are equal');
    expect(e.span).toEqual({ start: 7, end: 8 });
  });

  it('refuses absurdly deep nesting instead of overflowing the stack', () => {
    const deep = `${'('.repeat(500)}1${')'.repeat(500)}`;
    expect(parseError(deep).message).toBe('This formula is nested too deeply');
    expect(show(parse(`${'('.repeat(50)}1${')'.repeat(50)}`))).toBe('1');
  });
});
