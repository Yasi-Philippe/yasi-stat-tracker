import { describe, expect, it } from 'vitest';
import formulasDoc from '../../../docs/FORMULAS.md?raw';
import { FUNCTION_DOCS } from './functions';
import { d, makeSource, rng, walk } from './testkit';
import { Workspace } from './workspace';

// A workspace with every name used in the documentation, filled with made-up data.
const random = rng(7);
const from = d('2021-01-01');
const to = d('2026-10-11');
const monthly = (base: number, spread: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let y = 2021; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) out.push([d(`${y}-${String(m).padStart(2, '0')}-01`), base + random() * spread]);
  }
  return out;
};
const ws = new Workspace(
  makeSource({
    today: '2026-10-11',
    metrics: [
      { slug: 'weight', points: walk(random, from, to, 82, { noise: 0.3, skip: 0.3 }) },
      { slug: 'height', fill: 'step', points: [['2021-01-01', 178]] },
      { slug: 'bank', fill: 'step', points: walk(random, from, to, 4000, { noise: 40 }) },
      { slug: 'stocks', fill: 'step', points: walk(random, d('2022-01-01'), to, 1000, { noise: 10 }) },
      { slug: 'savings', fill: 'step', points: walk(random, d('2023-01-01'), to, 500, { noise: 5, skip: 0.5 }) },
      { slug: 'steps', points: walk(random, from, to, 9000, { noise: 800 }) },
      { slug: 'sleep', points: walk(random, from, to, 7, { noise: 0.3 }) },
      { slug: 'monthly_expenses', cadence: 'monthly', points: monthly(1500, 800) },
      { slug: 'monthly_balance', cadence: 'monthly', points: monthly(-300, 1500) },
      { slug: 'lifetime_need', fill: 'step', points: [['2021-03-01', 900_000]] },
      { slug: 'monthly_need', fill: 'step', points: [['2021-03-01', 2500], ['2024-01-01', 2700]] },
    ],
    formulas: { networth: 'bank + fill(stocks, 0) + fill(savings, 0)', bmi: 'weight / (height / 100) ^ 2' },
  }),
);

function expectWorking(expr: string): void {
  const result = ws.validate(expr);
  expect(result.ok ? 'ok' : result.error.message, expr).toBe('ok');
  expect(() => ws.evalExpr(expr), expr).not.toThrow();
}

describe('documentation', () => {
  it('every function is in docs/FORMULAS.md with its exact signature', () => {
    for (const f of FUNCTION_DOCS) expect(formulasDoc, f.name).toContain(`#### \`${f.signature}\``);
  });

  it('every function example works', () => {
    for (const f of FUNCTION_DOCS) expectWorking(f.example);
  });

  it('the formulas of the examples table and the code blocks work', () => {
    const table = formulasDoc.split('## A few examples')[1].split('\n## ')[0];
    const fromTable = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    const fromBlocks = [...formulasDoc.matchAll(/^[ \t]*```\n([^`]+?)\n[ \t]*```/gm)].map((m) => m[1].trim());
    expect(fromTable.length).toBeGreaterThan(5);
    expect(fromBlocks.length).toBeGreaterThan(1);
    for (const expr of [...fromTable, ...fromBlocks]) expectWorking(expr);
  });
});
