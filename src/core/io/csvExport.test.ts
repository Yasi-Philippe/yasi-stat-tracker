import { describe, expect, it } from 'vitest';
import { deriveDataKeys, generateDek } from '../crypto/keys';
import { entries, metrics, newId, saveMetric, setEntry } from '../data/repo';
import type { MetricDef } from '../model/types';
import { LocalStore } from '../vault/localStore';
import { Vault } from '../vault/vault';
import { exportCsv } from './csvExport';
import { analyzeTable, applyImport, guessHeaderRow } from './importer';
import { parseDelimited } from './table';

async function newVault(): Promise<Vault> {
  return Vault.open(new LocalStore(`io-csv-${Math.random()}`), await deriveDataKeys(generateDek()), { persistDelayMs: 60_000 });
}

function add(vault: Vault, patch: Partial<MetricDef>): MetricDef {
  const m: MetricDef = { id: newId(), slug: 'm', name: 'M', unit: '', cadence: 'daily', fill: 'none', decimals: 2, step: 0.01, order: 1, ...patch };
  saveMetric(vault, m);
  return m;
}

describe('exportCsv', () => {
  it('writes one row per date with any value, one column per metric', async () => {
    const vault = await newVault();
    const w = add(vault, { slug: 'w', name: 'Weight', unit: 'kg', order: 1 });
    const n = add(vault, { slug: 'n', name: 'Notes, "quoted"', order: 2, decimals: 10 });
    const old = add(vault, { slug: 'o', name: 'Old', order: 3, archived: true, cadence: 'monthly' });
    setEntry(vault, w, '2024-01-02', 80.5);
    setEntry(vault, w, '2024-01-01', -0.25);
    setEntry(vault, n, '2024-01-03', 0.0000001);
    setEntry(vault, old, '2024-01-15', 1200);
    expect(exportCsv(vault)).toBe(
      'date,Weight (kg),"Notes, ""quoted""",Old\r\n' +
        '2024-01-01,-0.25,,1200\r\n' +
        '2024-01-02,80.5,,\r\n' +
        '2024-01-03,,0.0000001,\r\n',
    );
    expect(exportCsv(vault, [old.id, 'missing', w.id])).toBe('date,Old,Weight (kg)\r\n2024-01-01,1200,-0.25\r\n2024-01-02,,80.5\r\n');
    expect(exportCsv(await newVault())).toBe('date\r\n');
  });

  it('round-trips through the importer', async () => {
    const source = await newVault();
    const w = add(source, { slug: 'w', name: 'Weight', unit: 'kg', decimals: 1, order: 1 });
    const s = add(source, { slug: 's', name: 'Savings', unit: '€', decimals: 2, order: 2 });
    for (let d = 1; d <= 28; d++) {
      const date = `2024-02-${String(d).padStart(2, '0')}`;
      setEntry(source, w, date, 80 - d / 10);
      if (d % 7 === 0) setEntry(source, s, date, 1000.5 * d);
    }
    const table = parseDelimited(exportCsv(source));
    const headerRow = guessHeaderRow(table);
    const a = analyzeTable(table, headerRow);
    expect(a).toMatchObject({ suggestedDateColumn: 0, dateFormat: 'ymd', decimal: '.' });
    expect(a.columns[1]!.suggested).toMatchObject({ name: 'Weight', unit: 'kg', decimals: 1 });
    expect(a.columns[2]!.suggested).toMatchObject({ name: 'Savings', unit: '€' });

    const target = await newVault();
    applyImport(target, {
      table,
      headerRow,
      dateColumn: 0,
      dateFormat: a.dateFormat!,
      decimal: a.decimal,
      targets: {
        1: { kind: 'new', ...a.columns[1]!.suggested },
        2: { kind: 'new', ...a.columns[2]!.suggested, decimals: 2 },
      },
      onConflict: 'skip',
    });
    const [tw, ts] = metrics(target);
    const values = (v: Vault, id: string) => entries(v, id).map((e) => [e.date, e.value]);
    expect(values(target, tw!.id)).toEqual(values(source, w.id));
    expect(values(target, ts!.id)).toEqual(values(source, s.id));
  });
});
