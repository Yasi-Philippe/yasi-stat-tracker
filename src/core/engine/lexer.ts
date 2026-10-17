/**
 * Tokenizer for the formula language. Every token carries its character
 * offsets so the editor can underline the exact place of an error.
 *
 * - Numbers: 12, 3.5, .5, 1e3, 2.5E-3, with "_" between digits as a separator
 *   (1_250_000).
 * - Text in double quotes, used for dates and reducer names ("2021-03-01",
 *   "median"). Typographic quotes (“…”) are accepted too, because phone
 *   keyboards insert them.
 * - Names: [A-Za-z_][A-Za-z0-9_]*, case-sensitive.
 * - Operators and punctuation: + - * / ^ ( ) , < <= > >= == !=
 */

import { ExprError } from './types';

interface TokenBase {
  /** Exact source text of the token. */
  text: string;
  /** Offset of the first character. */
  start: number;
  /** Offset just past the last character. */
  end: number;
}

export interface NumToken extends TokenBase {
  type: 'num';
  value: number;
}

export interface StrToken extends TokenBase {
  type: 'str';
  /** The text between the quotes. */
  value: string;
}

export interface IdentToken extends TokenBase {
  type: 'ident';
}

/** Operators and punctuation. */
export interface OpToken extends TokenBase {
  type: 'op';
}

export interface EofToken extends TokenBase {
  type: 'eof';
}

/** Produced by `scan` in place of text that is not valid. */
export interface ErrorToken extends TokenBase {
  type: 'error';
  message: string;
}

export type Token = NumToken | StrToken | IdentToken | OpToken | EofToken;
export type ScanToken = Token | ErrorToken;

const OPERATORS_2 = ['<=', '>=', '==', '!='];
const OPERATORS_1 = '+-*/^(),<>';
const OPEN_QUOTES = '"“”„';
const CLOSE_QUOTES = '"“”';
const SINGLE_QUOTES = "'‘’";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Letters of any script, digits and "_": read as one word so bad names are reported whole. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

/**
 * Splits a formula into tokens without throwing: invalid text becomes an
 * 'error' token, so an editor can still highlight the rest while the user is
 * typing. The list always ends with an 'eof' token.
 */
export function scan(text: string): ScanToken[] {
  const out: ScanToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    const start = i;

    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      const token = scanNumber(text, i);
      out.push(token);
      i = token.end;
      continue;
    }

    if (OPEN_QUOTES.includes(c)) {
      let j = i + 1;
      while (j < n && !CLOSE_QUOTES.includes(text[j])) j++;
      if (j >= n) {
        out.push({ type: 'error', text: text.slice(i), start, end: n, message: 'This text has no closing quote (")' });
        i = n;
      } else {
        out.push({ type: 'str', text: text.slice(i, j + 1), value: text.slice(i + 1, j), start, end: j + 1 });
        i = j + 1;
      }
      continue;
    }

    if (SINGLE_QUOTES.includes(c)) {
      let j = i + 1;
      while (j < n && !SINGLE_QUOTES.includes(text[j])) j++;
      const end = j < n ? j + 1 : n;
      const inner = text.slice(i + 1, j);
      out.push({
        type: 'error',
        text: text.slice(i, end),
        start,
        end,
        message: `Use double quotes for text, like "${inner}"`,
      });
      i = end;
      continue;
    }

    if (WORD_CHAR.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(text[j])) j++;
      const word = text.slice(i, j);
      if (NAME_RE.test(word)) {
        out.push({ type: 'ident', text: word, start, end: j });
      } else {
        out.push({
          type: 'error',
          text: word,
          start,
          end: j,
          message: `Invalid name "${word}": names can only use the letters a-z and A-Z, digits and "_"`,
        });
      }
      i = j;
      continue;
    }

    const two = text.slice(i, i + 2);
    if (OPERATORS_2.includes(two)) {
      out.push({ type: 'op', text: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if (OPERATORS_1.includes(c)) {
      out.push({ type: 'op', text: c, start, end: i + 1 });
      i++;
      continue;
    }

    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    let message = `Unexpected character "${ch}"`;
    if (c === '=') message = 'Use "==" to check whether two values are equal';
    else if (c === '!') message = 'Use "!=" to check whether two values are different';
    out.push({ type: 'error', text: ch, start, end: i + ch.length, message });
    i += ch.length;
  }
  out.push({ type: 'eof', text: '', start: n, end: n });
  return out;
}

/** Like `scan`, but throws an ExprError at the first invalid token. */
export function tokenize(text: string): Token[] {
  const tokens = scan(text);
  const tokensOnly: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'error') throw new ExprError(t.message, { start: t.start, end: t.end });
    tokensOnly.push(t);
  }
  return tokensOnly;
}

function scanNumber(text: string, start: number): NumToken | ErrorToken {
  let i = start;
  const digits = (): void => {
    while (isDigit(text[i]) || text[i] === '_') i++;
  };
  digits();
  if (text[i] === '.') {
    i++;
    digits();
  }
  if (text[i] === 'e' || text[i] === 'E') {
    let j = i + 1;
    if (text[j] === '+' || text[j] === '-') j++;
    if (isDigit(text[j])) {
      i = j;
      digits();
    }
  }
  const body = text.slice(start, i);

  // Letters, digits or dots glued to the number make it invalid: "2x", "1.2.3".
  let end = i;
  while (end < text.length && (WORD_CHAR.test(text[end]) || text[end] === '.')) end++;
  if (end > i) {
    const shown = text.slice(start, end);
    const rest = text.slice(i, end);
    const hint = NAME_RE.test(rest) && !/^[eE]\d*$/.test(rest) ? `. To multiply, write ${body} * ${rest}` : '';
    return { type: 'error', text: shown, start, end, message: `Invalid number "${shown}"${hint}` };
  }

  if (/(^|[^0-9])_|_([^0-9]|$)/.test(body)) {
    return {
      type: 'error',
      text: body,
      start,
      end: i,
      message: `Invalid number "${body}": "_" can only go between digits, like 1_000`,
    };
  }
  const value = Number(body.replace(/_/g, ''));
  if (!Number.isFinite(value)) {
    return { type: 'error', text: body, start, end: i, message: `The number "${body}" is too large` };
  }
  return { type: 'num', text: body, value, start, end: i };
}
