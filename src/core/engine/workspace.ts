/**
 * A Workspace evaluates metrics, formulas and free expressions against one
 * snapshot of the user's data. Results are memoized, so create a new
 * Workspace whenever the data changes, and treat returned values as
 * read-only.
 */

import type { FormulaDef, MetricDef } from '../model/types';
import { check, evaluate, type Env, type NameScope } from './evaluate';
import { parse, type Node } from './parser';
import { clip, fromArrays, type DayRange } from './series';
import { ExprError, type DataSource, type Series, type Span, type Value } from './types';
import { closest } from './util';
import { FUNCTIONS } from './functions';

export type { DayRange } from './series';

export type ValidateResult = { ok: true; deps: string[] } | { ok: false; error: ExprError };

export interface IdentifierInfo {
  slug: string;
  name: string;
  unit: string;
  kind: 'metric' | 'formula';
}

interface Compiled {
  ast: Node;
  deps: string[];
}

/** A dependency cycle between formulas. */
class CycleError extends ExprError {}

/** An error inside another formula, reported where that formula is used. */
class NestedError extends ExprError {}

type Memo = Map<string, Value | ExprError>;

export class Workspace {
  readonly source: DataSource;
  private readonly metrics = new Map<string, MetricDef>();
  private readonly formulas = new Map<string, FormulaDef>();
  private readonly scope: NameScope;
  /** Full, unclipped series of each metric, by slug. */
  private readonly base = new Map<string, Series>();
  /** Values of slugs, by range key then slug. */
  private readonly memo = new Map<string, Memo>();
  /** Values of free expressions, by range key then expression text. */
  private readonly exprMemo = new Map<string, Memo>();
  private readonly compiled = new Map<string, Compiled | ExprError>();
  private readonly envs = new Map<string, Env>();
  /** Formulas being evaluated, outermost first, to detect cycles. */
  private readonly stack: string[] = [];

  constructor(src: DataSource) {
    this.source = src;
    for (const m of src.metrics) if (!this.metrics.has(m.slug)) this.metrics.set(m.slug, m);
    // A metric wins over a formula with the same slug.
    for (const f of src.formulas) if (!this.metrics.has(f.slug) && !this.formulas.has(f.slug)) this.formulas.set(f.slug, f);
    this.scope = {
      has: (name) => this.metrics.has(name) || this.formulas.has(name),
      names: () => [...this.metrics.keys(), ...this.formulas.keys()],
    };
  }

  /**
   * Value of a metric or formula slug. With a range, every metric is first
   * clipped to it (step metrics get their value in force on `from`), and
   * formulas are evaluated on the clipped metrics. Memoized per (slug, range).
   * Throws an ExprError for unknown slugs and broken or circular formulas.
   */
  value(slug: string, range?: DayRange | null): Value {
    return this.resolve(slug, normalize(range));
  }

  /** Parses, checks and evaluates an expression. Throws ExprError. */
  evalExpr(expr: string, range?: DayRange | null): Value {
    const r = normalize(range);
    const memo = this.memoFor(this.exprMemo, r);
    const hit = memo.get(expr);
    if (hit !== undefined) {
      if (hit instanceof ExprError) throw hit;
      return hit;
    }
    try {
      const value = evaluate(this.compile(expr).ast, this.env(r));
      memo.set(expr, value);
      return value;
    } catch (e) {
      if (e instanceof ExprError) memo.set(expr, e);
      throw e;
    }
  }

  /**
   * Parses an expression and checks its names, function arity and written
   * arguments without evaluating it. `deps` lists the metric and formula
   * slugs it uses directly. With `self` (the slug of the formula being
   * edited), also reports an error if the expression would depend on itself.
   */
  validate(expr: string, options?: { self?: string }): ValidateResult {
    try {
      const { ast, deps } = this.compile(expr);
      if (options?.self) this.checkSelfReference(ast, options.self);
      return { ok: true, deps: [...deps] };
    } catch (e) {
      if (e instanceof ExprError) return { ok: false, error: e };
      throw e;
    }
  }

  /**
   * First and last day of the metric entries an expression uses, directly or
   * through formulas; null when it uses no data or does not compile. Lets a
   * chart find its time range when a series is a single number, such as
   * last(networth) - first(networth).
   */
  dataRange(expr: string): DayRange | null {
    let lo = Infinity;
    let hi = -Infinity;
    const seen = new Set<string>();
    const depsOf = (text: string): string[] => {
      try {
        return this.compile(text).deps;
      } catch {
        return [];
      }
    };
    const visit = (slug: string): void => {
      if (seen.has(slug)) return;
      seen.add(slug);
      const metric = this.metrics.get(slug);
      if (metric) {
        const s = this.metricSeries(metric);
        if (s.t.length > 0) {
          lo = Math.min(lo, s.t[0]);
          hi = Math.max(hi, s.t[s.t.length - 1]);
        }
        return;
      }
      const formula = this.formulas.get(slug);
      if (formula) depsOf(formula.expr).forEach(visit);
    };
    depsOf(expr).forEach(visit);
    return lo <= hi ? { from: lo, to: hi } : null;
  }

  /**
   * Whether an expression depends on any metric, directly or through
   * formulas. A chart whose metrics are merely empty shows "no data" rather
   * than an error.
   */
  usesMetrics(expr: string): boolean {
    const seen = new Set<string>();
    const depsOf = (text: string): string[] => {
      try {
        return this.compile(text).deps;
      } catch {
        return [];
      }
    };
    const visit = (slug: string): boolean => {
      if (seen.has(slug)) return false;
      seen.add(slug);
      if (this.metrics.has(slug)) return true;
      const formula = this.formulas.get(slug);
      return formula ? depsOf(formula.expr).some(visit) : false;
    };
    return depsOf(expr).some(visit);
  }

  /** Every metric and then every formula, in their display order, for autocomplete. */
  identifiers(): IdentifierInfo[] {
    const byOrder = (a: { order: number }, b: { order: number }): number => a.order - b.order;
    return [
      ...[...this.metrics.values()].sort(byOrder).map((m) => ({
        slug: m.slug,
        name: m.name,
        unit: m.unit,
        kind: 'metric' as const,
      })),
      ...[...this.formulas.values()].sort(byOrder).map((f) => ({
        slug: f.slug,
        name: f.name,
        unit: f.unit,
        kind: 'formula' as const,
      })),
    ];
  }

  // -------------------------------------------------------------------------

  private compile(expr: string): Compiled {
    let c = this.compiled.get(expr);
    if (c === undefined) {
      try {
        const ast = parse(expr);
        c = { ast, deps: check(ast, this.scope) };
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        c = e;
      }
      this.compiled.set(expr, c);
    }
    if (c instanceof ExprError) throw c;
    return c;
  }

  private memoFor(store: Map<string, Memo>, r: DayRange | null): Memo {
    const key = rangeKey(r);
    let memo = store.get(key);
    if (!memo) {
      memo = new Map();
      store.set(key, memo);
    }
    return memo;
  }

  private env(r: DayRange | null): Env {
    const key = rangeKey(r);
    let env = this.envs.get(key);
    if (!env) {
      env = {
        range: r,
        today: this.source.today,
        lookup: (name, span) => this.lookup(name, r, span),
        unrestricted: () => this.env(null),
      };
      this.envs.set(key, env);
    }
    return env;
  }

  private resolve(slug: string, r: DayRange | null): Value {
    const memo = this.memoFor(this.memo, r);
    const hit = memo.get(slug);
    if (hit !== undefined) {
      if (hit instanceof ExprError) throw hit;
      return hit;
    }

    const metric = this.metrics.get(slug);
    if (metric) {
      const full = this.metricSeries(metric);
      const value = r ? clip(full, r.from, r.to) : full;
      memo.set(slug, value);
      return value;
    }

    const formula = this.formulas.get(slug);
    if (!formula) {
      const hint = closest(slug, [...this.scope.names(), ...FUNCTIONS.keys()]);
      throw new ExprError(hint ? `Unknown name "${slug}". Did you mean "${hint}"?` : `Unknown name "${slug}"`, null, hint);
    }

    const at = this.stack.indexOf(slug);
    if (at >= 0) {
      throw new CycleError(`Circular reference: ${[...this.stack.slice(at), slug].join(' → ')}`);
    }
    this.stack.push(slug);
    try {
      const value = evaluate(this.compile(formula.expr).ast, this.env(r));
      memo.set(slug, value);
      return value;
    } catch (e) {
      // Safe to keep: a formula only fails because of a cycle if it is on that cycle.
      if (e instanceof ExprError) memo.set(slug, e);
      throw e;
    } finally {
      this.stack.pop();
    }
  }

  /** Resolves a name used inside an expression, reporting errors of other formulas at the name. */
  private lookup(name: string, r: DayRange | null, span: Span): Value {
    try {
      return this.resolve(name, r);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      if (e instanceof CycleError) throw new CycleError(e.message, span);
      if (e instanceof NestedError) throw new NestedError(e.message, span);
      throw new NestedError(`Error in "${name}": ${e.message}`, span);
    }
  }

  private metricSeries(metric: MetricDef): Series {
    let s = this.base.get(metric.slug);
    if (!s) {
      const raw = this.source.entries(metric.id);
      s = fromArrays(raw.t, raw.v, metric.fill === 'step');
      this.base.set(metric.slug, s);
    }
    return s;
  }

  /** Throws a CycleError if `ast` depends on `self`, directly or through other formulas. */
  private checkSelfReference(ast: Node, self: string): void {
    const depsOf = (slug: string): string[] => {
      const f = this.formulas.get(slug);
      if (!f) return [];
      try {
        return this.compile(f.expr).deps;
      } catch {
        return [];
      }
    };
    const pathTo = (slug: string, seen: Set<string>): string[] | null => {
      if (slug === self) return [slug];
      if (seen.has(slug)) return null;
      seen.add(slug);
      for (const dep of depsOf(slug)) {
        const path = pathTo(dep, seen);
        if (path) return [slug, ...path];
      }
      return null;
    };
    const seen = new Set<string>();
    const visit = (node: Node): void => {
      switch (node.type) {
        case 'ident': {
          const path = pathTo(node.name, seen);
          if (path) throw new CycleError(`Circular reference: ${[self, ...path].join(' → ')}`, node.span);
          return;
        }
        case 'neg':
          visit(node.arg);
          return;
        case 'binary':
          visit(node.left);
          visit(node.right);
          return;
        case 'call':
          node.args.forEach(visit);
          return;
        default:
          return;
      }
    };
    visit(ast);
  }
}

function normalize(range: DayRange | null | undefined): DayRange | null {
  return range ? { from: range.from, to: range.to } : null;
}

function rangeKey(r: DayRange | null): string {
  return r ? `${r.from}:${r.to}` : '*';
}
