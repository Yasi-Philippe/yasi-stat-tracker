/**
 * Plain, unencrypted CSV of metric values: one row per date that has any
 * value, one column per metric. Formulas and entry notes are not included.
 */

import { entries, metric, metrics } from '../data/repo';
import type { ISODate } from '../model/dates';
import type { MetricDef } from '../model/types';
import type { Vault } from '../vault/vault';

/**
 * Wide CSV: `date,<name (unit)>…`, ISO dates, '.' decimals, CRLF line ends.
 * metricIds picks and orders the columns (unknown ids are ignored); by
 * default every metric, archived ones included, in their display order.
 */
export function exportCsv(vault: Vault, metricIds?: string[]): string {
  const list = metricIds
    ? metricIds.map((id) => metric(vault, id)).filter((m): m is MetricDef => m !== undefined)
    : metrics(vault, { includeArchived: true });
  const byDate = new Map<ISODate, Array<number | undefined>>();
  list.forEach((m, i) => {
    for (const e of entries(vault, m.id)) {
      let row = byDate.get(e.date);
      if (!row) byDate.set(e.date, (row = new Array<number | undefined>(list.length)));
      row[i] = e.value;
    }
  });
  const lines = [['date', ...list.map((m) => (m.unit ? `${m.name} (${m.unit})` : m.name))].map(csvField).join(',')];
  for (const date of [...byDate.keys()].sort()) {
    const row = byDate.get(date)!;
    lines.push([date, ...list.map((_, i) => (row[i] === undefined ? '' : plainNumber(row[i])))].join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function csvField(s: string): string {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Decimal notation without exponents: 1e-7 → "0.0000001". */
function plainNumber(v: number): string {
  if (v === 0) return '0';
  const s = String(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2]! + (m[3] ?? '');
  const point = m[2]!.length + Number(m[4]);
  if (point <= 0) return `${m[1]}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return m[1] + digits + '0'.repeat(point - digits.length);
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}
