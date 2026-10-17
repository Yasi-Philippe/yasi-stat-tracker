/**
 * Pratt parser for the formula language. Produces an AST whose nodes keep
 * their source spans, so later checks and evaluation errors can point at the
 * exact place in the editor.
 *
 * Operators, from lowest to highest precedence:
 *   comparisons  < <= > >= == !=   give 1 (true) or 0 (false); not chainable
 *   + -
 *   * /
 *   unary -                        so -2^2 = -4
 *   ^                              right-associative: 2^3^2 = 2^9
 */

import { tokenize, type IdentToken, type Token } from './lexer';
import { ExprError, type Span } from './types';

export type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type BinaryOp = '+' | '-' | '*' | '/' | '^' | CompareOp;

interface NodeBase {
  /** Source range of the whole node, parentheses included. */
  span: Span;
  /** True when the expression was written inside parentheses. */
  parens?: boolean;
}

export interface NumNode extends NodeBase {
  type: 'num';
  value: number;
}

export interface StrNode extends NodeBase {
  type: 'str';
  value: string;
}

export interface IdentNode extends NodeBase {
  type: 'ident';
  name: string;
}

export interface CallNode extends NodeBase {
  type: 'call';
  name: string;
  nameSpan: Span;
  args: Node[];
}

export interface NegNode extends NodeBase {
  type: 'neg';
  arg: Node;
}

export interface BinaryNode extends NodeBase {
  type: 'binary';
  op: BinaryOp;
  left: Node;
  right: Node;
  opSpan: Span;
}

export type Node = NumNode | StrNode | IdentNode | CallNode | NegNode | BinaryNode;

/** Left binding power of each infix operator. */
const BINDING: Record<BinaryOp, number> = {
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '==': 10,
  '!=': 10,
  '+': 20,
  '-': 20,
  '*': 30,
  '/': 30,
  '^': 50,
};
const COMPARE_BINDING = 10;
const PREFIX_BINDING = 40;
const MAX_DEPTH = 200;

/** Parses a formula. Throws an ExprError with the span of the problem. */
export function parse(text: string): Node {
  return new Parser(tokenize(text)).formula();
}

function spanOf(t: { start: number; end: number }): Span {
  return { start: t.start, end: t.end };
}

function isOp(t: Token, text: string): boolean {
  return t.type === 'op' && t.text === text;
}

function infixOp(t: Token): BinaryOp | null {
  return t.type === 'op' && Object.hasOwn(BINDING, t.text) ? (t.text as BinaryOp) : null;
}

function isComparison(node: Node): boolean {
  return node.type === 'binary' && !node.parens && BINDING[node.op] === COMPARE_BINDING;
}

function startsValue(t: Token): boolean {
  return t.type === 'num' || t.type === 'str' || t.type === 'ident' || isOp(t, '(') || isOp(t, '-') || isOp(t, '+');
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  formula(): Node {
    if (this.peek().type === 'eof') throw new ExprError('The formula is empty');
    const node = this.expr(0);
    const t = this.peek();
    if (t.type !== 'eof') throw this.unexpected(t);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private expr(minBinding: number): Node {
    if (++this.depth > MAX_DEPTH) throw new ExprError('This formula is nested too deeply', spanOf(this.peek()));
    try {
      let left = this.prefix();
      for (;;) {
        const t = this.peek();
        const op = infixOp(t);
        if (op === null || BINDING[op] <= minBinding) break;
        if (BINDING[op] === COMPARE_BINDING && isComparison(left)) {
          throw new ExprError(
            "Comparisons can't be chained. To require both, multiply them: (a < b) * (b < c)",
            { start: left.span.start, end: t.end },
          );
        }
        this.pos++;
        // "^" is right-associative: its right side may contain another "^".
        const right = this.expr(op === '^' ? BINDING[op] - 1 : BINDING[op]);
        left = {
          type: 'binary',
          op,
          left,
          right,
          span: { start: left.span.start, end: right.span.end },
          opSpan: spanOf(t),
        };
      }
      return left;
    } finally {
      this.depth--;
    }
  }

  private prefix(): Node {
    const t = this.peek();
    if (!startsValue(t)) throw this.expectedValue(t);
    this.pos++;
    switch (t.type) {
      case 'num':
        return { type: 'num', value: t.value, span: spanOf(t) };
      case 'str':
        return { type: 'str', value: t.value, span: spanOf(t) };
      case 'ident':
        return isOp(this.peek(), '(') ? this.call(t) : { type: 'ident', name: t.text, span: spanOf(t) };
      default:
        break;
    }
    if (t.text === '(') {
      const inner = this.expr(0);
      const close = this.peek();
      if (isOp(close, ')')) {
        this.pos++;
        return { ...inner, span: { start: t.start, end: close.end }, parens: true };
      }
      if (close.type === 'eof') throw new ExprError('Expected ")" to close "("', spanOf(t));
      throw this.unexpected(close);
    }
    const arg = this.expr(PREFIX_BINDING);
    if (t.text === '+') return arg;
    return { type: 'neg', arg, span: { start: t.start, end: arg.span.end } };
  }

  private call(name: IdentToken): CallNode {
    const open = this.tokens[this.pos++];
    const head: Span = { start: name.start, end: open.end };
    const label = `${name.text}(`;
    const args: Node[] = [];
    const done = (close: Token): CallNode => ({
      type: 'call',
      name: name.text,
      nameSpan: spanOf(name),
      args,
      span: { start: name.start, end: close.end },
    });
    if (isOp(this.peek(), ')')) return done(this.tokens[this.pos++]);
    for (;;) {
      if (this.peek().type === 'eof') throw new ExprError(`Expected ")" to close "${label}"`, head);
      args.push(this.expr(0));
      const t = this.peek();
      if (isOp(t, ',')) {
        this.pos++;
        continue;
      }
      if (isOp(t, ')')) {
        this.pos++;
        return done(t);
      }
      if (t.type === 'eof') throw new ExprError(`Expected ")" to close "${label}"`, head);
      throw new ExprError(`Expected "," or ")" in "${label}", but found "${t.text}"`, spanOf(t));
    }
  }

  /** Error for a token that cannot start a value. */
  private expectedValue(t: Token): ExprError {
    const prev = this.pos > 0 ? this.tokens[this.pos - 1] : null;
    if (t.type === 'eof') {
      return prev
        ? new ExprError(`Expected a value after "${prev.text}"`, spanOf(prev))
        : new ExprError('The formula is empty');
    }
    return new ExprError(
      prev ? `Expected a value after "${prev.text}", but found "${t.text}"` : `Expected a value, but found "${t.text}"`,
      spanOf(t),
    );
  }

  /** Error for a token left over after a complete value. */
  private unexpected(t: Token): ExprError {
    if (isOp(t, ')')) return new ExprError('Unexpected ")": there is no "(" to close', spanOf(t));
    if (isOp(t, ',')) return new ExprError('Unexpected ",": commas only separate the arguments of a function', spanOf(t));
    if (startsValue(t)) return new ExprError(`Unexpected "${t.text}". Is an operator missing before it?`, spanOf(t));
    return new ExprError(`Unexpected "${t.text}"`, spanOf(t));
  }
}
