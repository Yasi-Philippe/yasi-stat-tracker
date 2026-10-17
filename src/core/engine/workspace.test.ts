import { describe, expect, it } from 'vitest';
import { asNumber, asSeries, d, makeSource, pts, type SourceInput } from './testkit';
import { ExprError } from './types';
import { Workspace } from './workspace';

const base: SourceInput = {
  today: '2024-12-31',
  metrics: [
    {
      slug: 'weight',
      name: 'Weight',
      unit: 'kg',
      points: [
        ['2023-12-30', 82],
        ['2024-01-02', 81],
        ['2024-03-15', 79],
        ['2024-07-01', 77],
        ['2025-01-03', 76],
      ],
    },
    { slug: 'height', name: 'Height', unit: 'cm', fill: 'step', points: [['2023-06-01', 180]] },
    {
      slug: 'bank',
      name: 'Bank',
      unit: 'EUR',
      fill: 'step',
      points: [
        ['2023-11-20', 1000],
        ['2024-02-01', 1500],
        ['2024-08-10', 2500],
        ['2025-02-01', 2600],
      ],
    },
    { slug: 'stocks', name: 'Stocks', unit: 'EUR', fill: 'step', points: [['2024-05-01', 300], ['2024-09-01', 450]] },
    { slug: 'plan', name: 'Plan', fill: 'step', points: [['2022-03-01', 50_000], ['2024-06-01', 60_000]] },
  ],
  formulas: {
    bmi: 'weight / (height / 100) ^ 2',
    networth: 'bank + fill(stocks, 0)',
    yearly_change: 'last(networth) - first(networth)',
    target: '25',
  },
};

function errorOf(fn: () => unknown): ExprError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error('expected an ExprError');
}

describe('Workspace.value', () => {
  it('gives metrics as series, step when the metric holds its value', () => {
    const ws = new Workspace(makeSource(base));
    const weight = asSeries(ws.value('weight'));
    expect(weight.step).toBe(false);
    expect(weight.t.length).toBe(5);
    expect(asSeries(ws.value('bank')).step).toBe(true);
  });

  it('evaluates formulas, including plain numbers', () => {
    const ws = new Workspace(makeSource(base));
    const bmi = pts(ws.value('bmi'));
    expect(bmi[0][0]).toBe('2023-12-30');
    expect(bmi[0][1]).toBeCloseTo(82 / 1.8 ** 2, 12);
    expect(asNumber(ws.value('target'))).toBe(25);
  });

  it('cleans up entries: sorted, one value per day, no NaN', () => {
    const src = makeSource({ metrics: [{ slug: 'x' }] });
    src.entries = () => ({ t: Int32Array.of(3, 1, 3, 2), v: Float64Array.of(30, 10, 31, NaN) });
    expect(pts(new Workspace(src).value('x'))).toEqual([
      ['1970-01-02', 10],
      ['1970-01-04', 31],
    ]);
  });

  it('reports unknown names with a suggestion', () => {
    const ws = new Workspace(makeSource(base));
    const e = errorOf(() => ws.value('wieght'));
    expect(e.message).toBe('Unknown name "wieght". Did you mean "weight"?');
    expect(e.hint).toBe('weight');
    expect(errorOf(() => ws.value('zzz')).message).toBe('Unknown name "zzz"');
  });

  it('prefers a metric over a formula with the same slug', () => {
    const ws = new Workspace(makeSource({ ...base, formulas: { weight: '1' } }));
    expect(ws.value('weight').kind).toBe('series');
  });
});

describe('memoization', () => {
  it('reads each metric once and reuses values per (slug, range)', () => {
    const src = makeSource(base);
    const ws = new Workspace(src);
    const range = { from: d('2024-01-01'), to: d('2024-12-31') };
    const a = ws.value('networth');
    const b = ws.value('networth');
    expect(b).toBe(a);
    const ra = ws.value('networth', range);
    expect(ws.value('networth', { ...range })).toBe(ra);
    expect(ra).not.toBe(a);
    for (let i = 0; i < 20; i++) ws.evalExpr(`networth * ${i} + bmi`, range);
    expect(src.calls.get('m-bank')).toBe(1);
    expect(src.calls.get('m-stocks')).toBe(1);
    expect(src.calls.get('m-weight')).toBe(1);
    expect(src.calls.has('m-plan')).toBe(false);
  });

  it('reuses expression results', () => {
    const ws = new Workspace(makeSource(base));
    expect(ws.evalExpr('ma(weight, 30)')).toBe(ws.evalExpr('ma(weight, 30)'));
  });
});

describe('circular references', () => {
  const cyclic: SourceInput = {
    ...base,
    formulas: { a: 'b + 1', b: 'a * 2 + weight', c: 'a * 2', s: 's + 1', ok: 'weight * 2' },
  };

  it('reports the cycle with the path', () => {
    const ws = new Workspace(makeSource(cyclic));
    const e = errorOf(() => ws.value('a'));
    expect(e.message).toBe('Circular reference: a → b → a');
    // Underlines "b" in the expression of a.
    expect(e.span).toEqual({ start: 0, end: 1 });
    expect(errorOf(() => new Workspace(makeSource(cyclic)).value('b')).message).toBe('Circular reference: b → a → b');
    expect(errorOf(() => ws.value('s')).message).toBe('Circular reference: s → s');
  });

  it('reports it, unchanged, where a cyclic formula is used', () => {
    const ws = new Workspace(makeSource(cyclic));
    const e = errorOf(() => ws.value('c'));
    expect(e.message).toBe('Circular reference: a → b → a');
    expect(e.span).toEqual({ start: 0, end: 1 });
    const inExpr = errorOf(() => ws.evalExpr('1 + c'));
    expect(inExpr.message).toBe('Circular reference: a → b → a');
    expect(inExpr.span).toEqual({ start: 4, end: 5 });
    // Formulas outside the cycle still work.
    expect(ws.value('ok').kind).toBe('series');
  });

  it('validate can tell whether an edited formula would depend on itself', () => {
    const ws = new Workspace(makeSource({ ...base, formulas: { a: 'b + 1', b: 'weight', c: 'a + b' } }));
    const r = ws.validate('c * 2', { self: 'b' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toBe('Circular reference: b → c → a → b');
    expect(r.error.span).toEqual({ start: 0, end: 1 });
    const direct = ws.validate('weight + b', { self: 'b' });
    expect(!direct.ok && direct.error.message).toBe('Circular reference: b → b');
    expect(ws.validate('weight * 2', { self: 'b' }).ok).toBe(true);
    expect(ws.validate('a', { self: 'c' }).ok).toBe(true);
  });
});

describe('errors inside other formulas', () => {
  const broken: SourceInput = {
    ...base,
    formulas: { bmi2: 'weight / heigt ^ 2', outer: 'bmi2 + 1', runtime: 'rolling(5, 3)' },
  };

  it('a formula reports its own error at its own text', () => {
    const ws = new Workspace(makeSource(broken));
    const e = errorOf(() => ws.value('bmi2'));
    expect(e.message).toBe('Unknown name "heigt". Did you mean "height"?');
    expect(e.span).toEqual({ start: 9, end: 14 });
    expect(e.hint).toBe('height');
  });

  it('a user of that formula sees the error at the name it wrote', () => {
    const ws = new Workspace(makeSource(broken));
    const e = errorOf(() => ws.evalExpr('bmi2 * 2'));
    expect(e.message).toBe('Error in "bmi2": Unknown name "heigt". Did you mean "height"?');
    expect(e.span).toEqual({ start: 0, end: 4 });
    expect(e.hint).toBeUndefined();
    // Through several formulas, the message names the formula to fix.
    const deep = errorOf(() => ws.evalExpr('10 + outer'));
    expect(deep.message).toBe('Error in "bmi2": Unknown name "heigt". Did you mean "height"?');
    expect(deep.span).toEqual({ start: 5, end: 10 });
    expect(errorOf(() => ws.evalExpr('runtime')).message).toBe(
      'Error in "runtime": "rolling" needs a series, not a single number',
    );
  });
});

describe('Workspace.validate and identifiers', () => {
  const ws = new Workspace(makeSource(base));

  it('lists direct dependencies once, in order of first use', () => {
    expect(ws.validate('bmi + weight * weight + max(height, 1)')).toEqual({
      ok: true,
      deps: ['bmi', 'weight', 'height'],
    });
    expect(ws.validate('since("2021-03-01") * 2')).toEqual({ ok: true, deps: [] });
  });

  it('returns errors instead of throwing, with a hint for close names', () => {
    const r = ws.validate('wieght * 2');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(ExprError);
    expect(r.error.message).toBe('Unknown name "wieght". Did you mean "weight"?');
    expect(r.error.hint).toBe('weight');
    expect(r.error.span).toEqual({ start: 0, end: 6 });
    const syntax = ws.validate('rolling(weight, 3');
    expect(!syntax.ok && syntax.error.message).toBe('Expected ")" to close "rolling("');
    // Case-only differences are suggested too; short names need a closer match.
    const upper = ws.validate('Weight');
    expect(!upper.ok && upper.error.hint).toBe('weight');
    const short = ws.validate('bnk');
    expect(!short.ok && short.error.hint).toBe('bank');
    const far = ws.validate('xy');
    expect(!far.ok && far.error.hint).toBeUndefined();
  });

  it('lists metrics, then formulas, for autocomplete', () => {
    expect(ws.identifiers().slice(0, 2)).toEqual([
      { slug: 'weight', name: 'Weight', unit: 'kg', kind: 'metric' },
      { slug: 'height', name: 'Height', unit: 'cm', kind: 'metric' },
    ]);
    expect(ws.identifiers().map((i) => `${i.kind}:${i.slug}`)).toEqual([
      'metric:weight',
      'metric:height',
      'metric:bank',
      'metric:stocks',
      'metric:plan',
      'formula:bmi',
      'formula:networth',
      'formula:yearly_change',
      'formula:target',
    ]);
  });
});

describe('restricted evaluation', () => {
  const year2024 = { from: d('2024-01-01'), to: d('2024-12-31') };

  it('clips metrics, inserting the value in force on the first day for step metrics', () => {
    const ws = new Workspace(makeSource(base));
    expect(pts(ws.value('bank', year2024))).toEqual([
      ['2024-01-01', 1000],
      ['2024-02-01', 1500],
      ['2024-08-10', 2500],
    ]);
    expect(pts(ws.value('weight', year2024)).map((p) => p[0])).toEqual(['2024-01-02', '2024-03-15', '2024-07-01']);
  });

  it('evaluates formulas on the clipped metrics', () => {
    const ws = new Workspace(makeSource(base));
    expect(pts(ws.value('networth', year2024))).toEqual([
      ['2024-01-01', 1000],
      ['2024-02-01', 1500],
      ['2024-05-01', 1800],
      ['2024-08-10', 2800],
      ['2024-09-01', 2950],
    ]);
    // The year's change: from the value in force on Jan 1 to the last value.
    expect(asNumber(ws.value('yearly_change', year2024))).toBe(1950);
    expect(asNumber(ws.evalExpr('last(networth) - first(networth)', year2024))).toBe(1950);
    // Whole history: from 1000 (bank only) to 2600 + 450.
    expect(asNumber(ws.value('yearly_change'))).toBe(2050);
  });

  it('rebases pct to the first value inside the range', () => {
    const ws = new Workspace(makeSource(base));
    expect(Array.from(asSeries(ws.evalExpr('pct(weight)', year2024)).v)).toEqual([0, ((79 - 81) / 81) * 100, ((77 - 81) / 81) * 100]);
    expect(asSeries(ws.evalExpr('pct(weight)')).v[0]).toBe(0);
  });

  it('keeps daily() and shift() inside the range', () => {
    const ws = new Workspace(makeSource(base));
    const range = { from: d('2024-08-01'), to: d('2024-08-31') };
    const days = pts(ws.evalExpr('daily(bank)', range));
    expect(days.length).toBe(31);
    expect(days[0]).toEqual(['2024-08-01', 1500]);
    expect(days[30]).toEqual(['2024-08-31', 2500]);
    // Metrics are clipped first: the inserted 08-01 point moves to 08-26, the
    // 08-10 point leaves the range.
    expect(pts(ws.evalExpr('shift(bank, 25)', range))).toEqual([['2024-08-26', 1500]]);
    expect(pts(ws.evalExpr('shift(bank, -5)', range))).toEqual([
      ['2024-08-01', 1500],
      ['2024-08-05', 2500],
    ]);
  });

  it('leaves date functions alone', () => {
    const ws = new Workspace(makeSource(base));
    const f = ws.evalExpr('since("2024-01-01")', year2024);
    expect(f.kind === 'fn' && f.at(d('2024-02-01'))).toBe(31);
  });

  it('since(x) counts from the first point of the whole history, even in a range', () => {
    const ws = new Workspace(makeSource(base));
    const f = ws.evalExpr('since(plan)', year2024);
    // plan starts on 2022-03-01, before the range.
    expect(f.kind === 'fn' && f.at(d('2024-03-01'))).toBe(d('2024-03-01') - d('2022-03-01'));
    // Inside the range, plan itself is clipped to start on Jan 1…
    expect(pts(ws.value('plan', year2024))[0]).toEqual(['2024-01-01', 50_000]);
    // …but the elapsed days still count from the true start.
    const v = pts(ws.evalExpr('plan - since(plan) * 10', year2024));
    expect(v[0]).toEqual(['2024-01-01', 50_000 - (d('2024-01-01') - d('2022-03-01')) * 10]);
  });

  it('ranges with no data give empty series and NaN aggregates', () => {
    const ws = new Workspace(makeSource(base));
    const range = { from: d('2010-01-01'), to: d('2010-12-31') };
    expect(pts(ws.value('bank', range))).toEqual([]);
    expect(asNumber(ws.evalExpr('mean(weight)', range))).toBeNaN();
  });
});
