import { describe, expect, it } from 'vitest';
import { deriveDataKeys, generateDek } from '../crypto/keys';
import { entries, getEntry, metric, metrics, newId, saveMetric, setEntry } from '../data/repo';
import type { MetricDef } from '../model/types';
import { LocalStore } from '../vault/localStore';
import { Vault } from '../vault/vault';
import { analyzeTable, applyImport, guessHeaderRow, ImportError, type ImportPlan, previewImport } from './importer';
import { type Cell, parseDelimited, type Table } from './table';

let dbCounter = 0;
async function newVault(): Promise<Vault> {
  const keys = await deriveDataKeys(generateDek());
  return Vault.open(new LocalStore(`io-import-${++dbCounter}-${Math.random()}`), keys, { persistDelayMs: 60_000 });
}

function addMetric(vault: Vault, patch: Partial<MetricDef> = {}): MetricDef {
  const m: MetricDef = {
    id: newId(),
    slug: 'weight',
    name: 'Weight',
    unit: 'kg',
    cadence: 'daily',
    fill: 'none',
    decimals: 1,
    step: 0.1,
    order: 1,
    ...patch,
  };
  saveMetric(vault, m);
  return m;
}

const csv = (...lines: string[]) => parseDelimited(lines.join('\n'));

describe('guessHeaderRow', () => {
  it('finds the header right above the data, skipping title rows', () => {
    expect(guessHeaderRow(csv('date,weight', '2024-01-01,80'))).toBe(0);
    expect(guessHeaderRow(csv('My log', '', 'Fecha;Peso', '01/02/2024;80,5'))).toBe(2);
    expect(guessHeaderRow({ name: 'x', rows: [['Date', null, 'Weight'], [new Date(0), null, 80]] })).toBe(0);
  });

  it('returns null when the first row is already data', () => {
    expect(guessHeaderRow(csv('2024-01-01,80', '2024-01-02,81'))).toBeNull();
    expect(guessHeaderRow(csv('Month,2023,2024', 'Jan,1,2'))).toBeNull();
    expect(guessHeaderRow({ name: 'x', rows: [] })).toBeNull();
  });
});

describe('analyzeTable', () => {
  const european = csv(
    'Mi registro',
    '',
    'Fecha;Peso (kg);Grasa;Notas;;Altura',
    ...Array.from({ length: 20 }, (_, i) => {
      const d = `${String(i + 1).padStart(2, '0')}/03/2024`;
      const weight = i === 3 ? '80,25' : `${80 - i / 10}`.replace('.', ',');
      return `${d};${weight};${(20 + i / 10).toFixed(1).replace('.', ',')} %;${i % 2 ? 'ok' : 'cansado'};;${i === 0 ? '1,80' : ''}`;
    }),
  );

  it('describes each column and suggests a date column, format and decimal mark', () => {
    const headerRow = guessHeaderRow(european);
    expect(headerRow).toBe(2);
    const a = analyzeTable(european, headerRow);
    expect(a).toMatchObject({ dataStart: 3, suggestedDateColumn: 0, dateFormat: 'dmy', dateAmbiguous: false, decimal: ',' });
    expect(a.columns.map((c) => [c.header, c.kind, c.filled])).toEqual([
      ['Fecha', 'date', 20],
      ['Peso (kg)', 'number', 20],
      ['Grasa', 'number', 20],
      ['Notas', 'text', 20],
      ['Column E', 'empty', 0],
      ['Altura', 'number', 1],
    ]);
    expect(a.columns[1]!.sample).toEqual(['80', '79,9', '79,8', '80,25', '79,6']);
    expect(a.columns[1]!.suggested).toEqual({ name: 'Peso', unit: 'kg', decimals: 2, cadence: 'daily', fill: 'none' });
    expect(a.columns[2]!.suggested).toMatchObject({ name: 'Grasa', unit: '%', decimals: 1 });
    // "1,80" reads as 1.8: trailing zeros do not count.
    expect(a.columns[5]!.suggested).toEqual({ name: 'Altura', unit: '', decimals: 1, cadence: 'sparse', fill: 'step' });
  });

  it('flags DD/MM versus MM/DD when no day is above 12', () => {
    const a = analyzeTable(csv('date,v', '01/02/2024,1', '01/03/2024,2', '01/04/2024,3'), 0);
    expect(a).toMatchObject({ dateFormat: 'dmy', dateAmbiguous: true });
    expect(a.columns[1]!.suggested.cadence).toBe('monthly');
  });

  it('suggests monthly metrics for month-only dates', () => {
    const a = analyzeTable(csv('Month,Rent (€)', '2024-01,900', '2024-02,900', '2024-03,950'), 0);
    expect(a.dateFormat).toBe('ym');
    expect(a.columns[1]!.suggested).toEqual({ name: 'Rent', unit: '€', decimals: 0, cadence: 'monthly', fill: 'none' });
  });

  it('treats serial numbers as dates only with supporting evidence', () => {
    const rows = (f: (i: number) => Cell[]) => Array.from({ length: 30 }, (_, i) => f(i));
    // An odometer counts up like a day number, but a real date column exists.
    const withDates: Table = {
      name: 'a',
      rows: [['Date', 'Odometer'], ...rows((i) => [new Date(Date.UTC(2024, 0, i + 1)), 45000 + 30 * i])],
    };
    const a = analyzeTable(withDates, 0);
    expect(a.columns.map((c) => c.kind)).toEqual(['date', 'number']);
    expect(a.dateFormat).toBe('native');
    // Serial dates under a date-like header; a balance in the same range is not a date.
    const serial: Table = {
      name: 'b',
      rows: [['Day', 'Balance'], ...rows((i) => [45292 + i, 45000 + ((i * 7919) % 1000)])],
    };
    const b = analyzeTable(serial, 0);
    expect(b.columns.map((c) => c.kind)).toEqual(['date', 'number']);
    expect(b).toMatchObject({ suggestedDateColumn: 0, dateFormat: 'serial' });
    // No header at all: the first day-by-day sequence is taken.
    const bare: Table = { name: 'c', rows: rows((i) => [80 + i / 10, 45292 + i]) };
    expect(analyzeTable(bare, null)).toMatchObject({ suggestedDateColumn: 1, dataStart: 0, dateFormat: 'serial' });
  });

  it('reports the format of a date column the user picked', () => {
    const t = csv('Start,End,v', '2024-01-01,05/01/2024,1', '2024-01-02,13/01/2024,2');
    expect(analyzeTable(t, 0)).toMatchObject({ suggestedDateColumn: 0, dateFormat: 'ymd' });
    expect(analyzeTable(t, 0, { dateColumn: 1 })).toMatchObject({ suggestedDateColumn: 0, dateFormat: 'dmy', dateAmbiguous: false });
    expect(analyzeTable(t, 0, { dateColumn: 2 }).dateFormat).toBeNull();
  });
});

describe('previewImport and applyImport', () => {
  const file = () =>
    csv(
      'date,weight,steps,spend',
      '2024-03-01,80.5,1000,10',
      '2024-03-02,80.3,abc,20',
      '2024-03-02,80.4,,30',
      'not a date,1,2,3',
      ',,,',
      '2024-04-05,79,500,40',
    );

  async function setup() {
    const vault = await newVault();
    const weight = addMetric(vault);
    setEntry(vault, weight, '2024-03-01', 80.5);
    setEntry(vault, weight, '2024-03-02', 70, 'new scale');
    const plan: ImportPlan = {
      table: file(),
      headerRow: 0,
      dateColumn: 0,
      dateFormat: 'ymd',
      decimal: '.',
      targets: {
        1: { kind: 'metric', metricId: weight.id },
        2: { kind: 'new', name: 'Steps', unit: '', cadence: 'daily', fill: 'none', decimals: 0 },
        3: { kind: 'new', name: 'Spend', unit: '€', cadence: 'monthly', fill: 'none', decimals: 2 },
      },
      onConflict: 'skip',
    };
    return { vault, weight, plan };
  }

  it('previews new entries, conflicts, duplicates and unreadable cells without writing', async () => {
    const { vault, plan } = await setup();
    const before = vault.version;
    const p = previewImport(vault, plan);
    expect(vault.version).toBe(before);
    expect(p.rows).toBe(5);
    expect(p.badDates).toEqual([4]);
    expect(p.badValues).toEqual([{ row: 2, column: 2, raw: 'abc' }]);
    expect(p.duplicateDates).toEqual(['2024-03-01', '2024-03-02']);
    expect(p.perColumn).toEqual([
      expect.objectContaining({ column: 1, values: 3, newEntries: 1, conflicts: 1, unchanged: 1, duplicates: 1, firstDate: '2024-03-01', lastDate: '2024-04-05' }),
      expect.objectContaining({ column: 2, values: 2, newEntries: 2, conflicts: 0, unchanged: 0, duplicates: 0 }),
      // Monthly: dates move to the 1st, so March gets three values and keeps the last.
      expect.objectContaining({ column: 3, values: 2, newEntries: 2, duplicates: 2, firstDate: '2024-03-01', lastDate: '2024-04-01' }),
    ]);
  });

  it('creates metrics and writes values in one batch, skipping conflicts', async () => {
    const { vault, weight, plan } = await setup();
    addMetric(vault, { slug: 'steps', name: 'Old steps', order: 7 });
    let notifications = 0;
    vault.subscribe(() => notifications++);
    const r = applyImport(vault, plan);
    expect(notifications).toBe(1);
    expect(r).toMatchObject({ entriesWritten: 5, skipped: 2 });
    expect(r.metricsCreated).toHaveLength(2);
    const [steps, spend] = r.metricsCreated.map((id) => metric(vault, id)!);
    expect(steps).toMatchObject({ name: 'Steps', slug: 'steps_2', decimals: 0, step: 1, order: 8, cadence: 'daily' });
    expect(spend).toMatchObject({ name: 'Spend', slug: 'spend', unit: '€', decimals: 2, step: 0.01, order: 9, cadence: 'monthly' });
    expect(spend!.hideFromToday).toBeUndefined();
    expect(entries(vault, spend!.id).map((e) => [e.date, e.value])).toEqual([
      ['2024-03-01', 30],
      ['2024-04-01', 40],
    ]);
    expect(entries(vault, steps!.id).map((e) => e.value)).toEqual([1000, 500]);
    expect(getEntry(vault, weight, '2024-03-02')).toMatchObject({ value: 70, note: 'new scale' });
    expect(getEntry(vault, weight, '2024-04-05')?.value).toBe(79);
  });

  it('overwrites conflicts on request and keeps their notes', async () => {
    const { vault, weight, plan } = await setup();
    const r = applyImport(vault, { ...plan, targets: { 1: plan.targets[1]! }, onConflict: 'overwrite' });
    expect(r).toEqual({ metricsCreated: [], entriesWritten: 2, skipped: 1 });
    expect(getEntry(vault, weight, '2024-03-02')).toMatchObject({ value: 80.4, note: 'new scale' });
  });

  it('merges two columns mapped to one metric, the later value winning', async () => {
    const vault = await newVault();
    const m = addMetric(vault, { decimals: 2 });
    const plan: ImportPlan = {
      table: csv('date,morning,evening', '2024-01-01,80,80.6', '2024-01-02,,81'),
      headerRow: 0,
      dateColumn: 0,
      dateFormat: 'ymd',
      decimal: '.',
      targets: { 1: { kind: 'metric', metricId: m.id }, 2: { kind: 'metric', metricId: m.id } },
      onConflict: 'skip',
    };
    const p = previewImport(vault, plan);
    expect(p.perColumn.map((c) => [c.column, c.values, c.duplicates])).toEqual([
      [1, 0, 0],
      [2, 2, 1],
    ]);
    applyImport(vault, plan);
    expect(entries(vault, m.id).map((e) => e.value)).toEqual([80.6, 81]);
  });

  it('gives new metrics unique, valid slugs and hides sparse ones from the daily screen', async () => {
    const vault = await newVault();
    const long = 'A very long metric name that goes on and on forever';
    const spec = { kind: 'new', name: long, unit: '', cadence: 'sparse', fill: 'step', decimals: 2 } as const;
    const plan: ImportPlan = {
      table: csv('date,a,b', '2024-01-01,1,2'),
      headerRow: 0,
      dateColumn: 0,
      dateFormat: 'ymd',
      decimal: '.',
      targets: { 1: spec, 2: spec },
      onConflict: 'skip',
    };
    const r = applyImport(vault, plan);
    const made = r.metricsCreated.map((id) => metric(vault, id)!);
    expect(made.map((m) => m.slug)).toEqual(['a_very_long_metric_name_that_goes_on_and', 'a_very_long_metric_name_that_goes_on']);
    for (const m of made) {
      expect(m.slug).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(m).toMatchObject({ hideFromToday: true, cadence: 'sparse', fill: 'step', step: 0.01 });
    }
  });

  it('rejects plans the UI should not have produced', async () => {
    const { vault, plan } = await setup();
    const code = (p: ImportPlan) => {
      try {
        previewImport(vault, p);
        return 'ok';
      } catch (err) {
        return err instanceof ImportError ? err.code : 'other';
      }
    };
    expect(code({ ...plan, targets: { 0: { kind: 'new', name: 'x', unit: '', cadence: 'daily', fill: 'none', decimals: 0 } } })).toBe('bad-plan');
    expect(code({ ...plan, targets: { 1: { kind: 'metric', metricId: 'gone' } } })).toBe('unknown-metric');
    expect(code({ ...plan, targets: { 1: { kind: 'new', name: '  ', unit: '', cadence: 'daily', fill: 'none', decimals: 0 } } })).toBe('bad-plan');
    expect(code({ ...plan, dateColumn: -1 })).toBe('bad-plan');
    expect(code({ ...plan, targets: { 1: { kind: 'skip' } } })).toBe('ok');
  });

  it('previews and applies 20,000 rows × 5 columns well under 2 s', async () => {
    const vault = await newVault();
    const existing = [addMetric(vault, { slug: 'w', order: 1 }), addMetric(vault, { slug: 'f', order: 2, decimals: 2 })];
    for (let i = 0; i < 1000; i++) setEntry(vault, existing[0]!, isoDay(i), 1);
    const lines = ['date,a,b,c,d,e'];
    for (let i = 0; i < 20_000; i++) {
      const v = (k: number) => (60 + ((i * (k + 3)) % 400) / 10).toFixed(1);
      lines.push([isoDay(i), v(0), v(1), `"${v(2)}"`, v(3), v(4)].join(','));
    }
    const table = parseDelimited(lines.join('\n'));
    const analysis = analyzeTable(table, guessHeaderRow(table));
    expect(analysis.columns.map((c) => c.kind)).toEqual(['date', 'number', 'number', 'number', 'number', 'number']);
    const plan: ImportPlan = {
      table,
      headerRow: 0,
      dateColumn: 0,
      dateFormat: analysis.dateFormat!,
      decimal: analysis.decimal,
      targets: {
        1: { kind: 'metric', metricId: existing[0]!.id },
        2: { kind: 'metric', metricId: existing[1]!.id },
        3: { kind: 'new', ...analysis.columns[3]!.suggested },
        4: { kind: 'new', ...analysis.columns[4]!.suggested },
        5: { kind: 'new', ...analysis.columns[5]!.suggested },
      },
      onConflict: 'overwrite',
    };
    const t0 = performance.now();
    const preview = previewImport(vault, plan);
    const r = applyImport(vault, plan);
    const ms = performance.now() - t0;
    expect(preview.perColumn[0]).toMatchObject({ values: 20_000, conflicts: 1000 });
    expect(r.entriesWritten).toBe(100_000);
    expect(metrics(vault)).toHaveLength(5);
    expect(ms).toBeLessThan(2000);
  });
});

function isoDay(i: number): string {
  return new Date(Date.UTC(1970, 0, 1 + i)).toISOString().slice(0, 10);
}
