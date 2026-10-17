/**
 * Static checks and evaluation of a parsed formula.
 */

import { isISODate, toDayNum, type DayNum } from '../model/dates';
import type { Reducer } from '../model/types';
import { FUNCTIONS, type Call, type FunctionSpec } from './functions';
import type { BinaryOp, CallNode, Node, StrNode } from './parser';
import { combine, mapValue, REDUCERS, scalar, type DayRange } from './series';
import { ExprError, type Span, type Value } from './types';
import { closest, ordinal } from './util';

/** The metric and formula names a formula may use. */
export interface NameScope {
  has(name: string): boolean;
  names(): Iterable<string>;
}

/** What evaluation needs from its surroundings. */
export interface Env {
  /** The range every metric is clipped to, if any. */
  range: DayRange | null;
  today: DayNum;
  /** Value of a metric or formula; `span` is where the name appears. */
  lookup(name: string, span: Span): Value;
  /** The same environment without any range restriction. */
  unrestricted(): Env;
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

/**
 * Checks names, function arity and the written arguments (dates, reducer
 * names) without evaluating anything. Returns the metric and formula names
 * used, in order of first use. Throws an ExprError with the span to underline.
 */
export function check(root: Node, scope: NameScope): string[] {
  const deps: string[] = [];
  const visit = (node: Node): void => {
    switch (node.type) {
      case 'num':
        return;
      case 'str':
        throw misplacedText(node, scope);
      case 'ident': {
        if (scope.has(node.name)) {
          if (!deps.includes(node.name)) deps.push(node.name);
          return;
        }
        const fn = FUNCTIONS.get(node.name);
        if (fn) throw new ExprError(`"${node.name}" is a function: use it like ${fn.signature}`, node.span);
        const hint = closest(node.name, [...scope.names(), ...FUNCTIONS.keys()]);
        throw new ExprError(
          hint ? `Unknown name "${node.name}". Did you mean "${hint}"?` : `Unknown name "${node.name}"`,
          node.span,
          hint,
        );
      }
      case 'neg':
        visit(node.arg);
        return;
      case 'binary':
        visit(node.left);
        visit(node.right);
        return;
      case 'call':
        checkCall(node, scope, visit);
        return;
    }
  };
  visit(root);
  return deps;
}

function checkCall(node: CallNode, scope: NameScope, visit: (n: Node) => void): void {
  const fn = FUNCTIONS.get(node.name);
  if (!fn) {
    if (scope.has(node.name)) {
      throw new ExprError(`"${node.name}" is not a function. Remove the parentheses to use its values`, node.span);
    }
    const hint = closest(node.name, [...FUNCTIONS.keys(), ...scope.names()]);
    throw new ExprError(
      hint ? `Unknown function "${node.name}". Did you mean "${hint}"?` : `Unknown function "${node.name}"`,
      node.nameSpan,
      hint,
    );
  }
  const n = node.args.length;
  if (n < fn.min || n > fn.max) throw new ExprError(`"${fn.name}" needs ${arityText(fn)}`, node.span);

  let previousDate: number | null = null;
  for (let i = 0; i < n; i++) {
    const arg = node.args[i];
    const kind = fn.args[Math.min(i, fn.args.length - 1)];
    const where = `The ${ordinal(i + 1)} argument of "${fn.name}"`;
    if (kind === 'date' || (kind === 'dateOrValue' && arg.type === 'str')) {
      if (arg.type !== 'str') throw new ExprError(`${where} must be a date in quotes, like "2021-03-01"`, arg.span);
      if (!isISODate(arg.value)) {
        throw new ExprError(`Invalid date "${arg.value}". Write dates as "YYYY-MM-DD", like "2021-03-01"`, arg.span);
      }
      const day = toDayNum(arg.value);
      if (previousDate !== null && day < previousDate) {
        throw new ExprError('The end date is before the start date', arg.span);
      }
      previousDate = day;
    } else if (kind === 'reducer') {
      const allowed = fn.reducers ?? REDUCERS;
      if (arg.type !== 'str') {
        if (arg.type === 'ident' && (allowed as readonly string[]).includes(arg.name)) {
          throw new ExprError(`Put the reducer name in quotes: "${arg.name}"`, arg.span, `"${arg.name}"`);
        }
        throw new ExprError(`${where} must be a reducer name in quotes, like "median"`, arg.span);
      }
      if (!(allowed as readonly string[]).includes(arg.value)) {
        const hint = closest(arg.value, allowed);
        throw new ExprError(
          hint
            ? `Unknown reducer "${arg.value}". Did you mean "${hint}"?`
            : `Unknown reducer "${arg.value}". Use one of: ${allowed.join(', ')}`,
          arg.span,
          hint === undefined ? undefined : `"${hint}"`,
        );
      }
    } else if (arg.type === 'str') {
      if (scope.has(arg.value)) throw misplacedText(arg, scope);
      throw new ExprError(`${where} must be ${kind === 'number' ? 'a number' : 'a value'}, not text in quotes`, arg.span);
    } else {
      visit(arg);
    }
  }
}

const TEXT_ONLY_FOR = 'Text in quotes is only used for dates (like "2021-03-01") and reducer names (like "median")';

function misplacedText(node: StrNode, scope: NameScope | null): ExprError {
  if (scope?.has(node.value)) {
    return new ExprError(`Remove the quotes around "${node.value}" to use its values`, node.span, node.value);
  }
  return new ExprError(TEXT_ONLY_FOR, node.span);
}

function arityText(fn: FunctionSpec): string {
  const args = (k: number): string => `${k} argument${k === 1 ? '' : 's'}`;
  if (fn.max === Infinity) return `at least ${args(fn.min)}`;
  if (fn.min === fn.max) return args(fn.min);
  if (fn.max === fn.min + 1) return `${fn.min} or ${args(fn.max)}`;
  return `${fn.min} to ${args(fn.max)}`;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function comparison(test: (a: number, b: number) => boolean): (a: number, b: number) => number {
  return (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : test(a, b) ? 1 : 0);
}

const BINARY: Record<BinaryOp, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '^': (a, b) => a ** b,
  '<': comparison((a, b) => a < b),
  '<=': comparison((a, b) => a <= b),
  '>': comparison((a, b) => a > b),
  '>=': comparison((a, b) => a >= b),
  '==': comparison((a, b) => a === b),
  '!=': comparison((a, b) => a !== b),
};

const negate = (x: number): number => -x;

/** Evaluates a checked AST. Throws an ExprError for value-type problems. */
export function evaluate(node: Node, env: Env): Value {
  switch (node.type) {
    case 'num':
      return scalar(node.value);
    case 'str':
      throw misplacedText(node, null);
    case 'ident':
      return env.lookup(node.name, node.span);
    case 'neg':
      return mapValue(evaluate(node.arg, env), negate);
    case 'binary': {
      const f = BINARY[node.op];
      return combine([evaluate(node.left, env), evaluate(node.right, env)], (xs) => f(xs[0], xs[1]));
    }
    case 'call': {
      const fn = FUNCTIONS.get(node.name);
      if (!fn) throw new ExprError(`Unknown function "${node.name}"`, node.nameSpan);
      return fn.run(new CallContext(node, env));
    }
  }
}

class CallContext implements Call {
  constructor(
    private readonly node: CallNode,
    private readonly env: Env,
  ) {}

  get name(): string {
    return this.node.name;
  }

  get argc(): number {
    return this.node.args.length;
  }

  get range(): DayRange | null {
    return this.env.range;
  }

  get today(): DayNum {
    return this.env.today;
  }

  value(i: number): Value {
    return evaluate(this.arg(i), this.env);
  }

  wholeValue(i: number): Value {
    return evaluate(this.arg(i), this.env.range ? this.env.unrestricted() : this.env);
  }

  number(i: number, fallback?: number): number {
    if (i >= this.argc && fallback !== undefined) return fallback;
    const v = this.value(i);
    const where = `The ${ordinal(i + 1)} argument of "${this.name}"`;
    if (v.kind === 'series') throw this.error(`${where} must be a single number, not a series`, i);
    if (v.kind === 'fn') throw this.error(`${where} must be a single number, not a date function`, i);
    if (Number.isNaN(v.value)) throw this.error(`${where} has no value: there is no data to compute it from`, i);
    return v.value;
  }

  isText(i: number): boolean {
    return this.arg(i).type === 'str';
  }

  date(i: number): DayNum {
    const a = this.arg(i);
    if (a.type !== 'str' || !isISODate(a.value)) {
      throw new ExprError(`The ${ordinal(i + 1)} argument of "${this.name}" must be a date in quotes, like "2021-03-01"`, a.span);
    }
    return toDayNum(a.value);
  }

  reducer(i: number, fallback: Reducer): Reducer {
    if (i >= this.argc) return fallback;
    const a = this.arg(i);
    if (a.type !== 'str' || !(REDUCERS as readonly string[]).includes(a.value)) {
      throw new ExprError(`The ${ordinal(i + 1)} argument of "${this.name}" must be a reducer name in quotes, like "median"`, a.span);
    }
    return a.value as Reducer;
  }

  error(message: string, i?: number): ExprError {
    const target = i === undefined || i >= this.argc ? this.node : this.node.args[i];
    return new ExprError(message, target.span);
  }

  private arg(i: number): Node {
    if (i >= this.argc) throw new ExprError(`"${this.name}" is missing its ${ordinal(i + 1)} argument`, this.node.span);
    return this.node.args[i];
  }
}
