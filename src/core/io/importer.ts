/**
 * Importing values from a table into metrics. The UI walks through: pick a
 * table → header row (guessHeaderRow) → date column and format, value
 * columns and their targets (analyzeTable) → conflict policy → preview
 * (previewImport) → apply (applyImport, one vault batch).
 *
 * Row numbers are indexes into table.rows (0-based); add 1 to show them.
 */

import {
  entryDate,
  getEntry,
  metric,
  metrics,
  newId,
  nextOrder,
  saveMetric,
  setEntry,
  slugify,
  uniqueSlug,
  usedSlugs,
} from '../data/repo';
import { type ISODate, toDayNum } from '../model/dates';
import type { Cadence, Fill, MetricDef } from '../model/types';
import type { Vault } from '../vault/vault';
import {
  DATE_FORMATS,
  type DateFormat,
  type DecimalSeparator,
  detectDateFormat,
  detectDecimalSeparator,
  isDateLike,
  parseDate,
  parseNumber,
  parseNumberParts,
} from './parse';
import { type Cell, columnName, isEmptyCell, type Table } from './table';

export type ColumnKind = 'date' | 'number' | 'text' | 'empty';

export type NewTarget = { kind: 'new'; name: string; unit: string; cadence: Cadence; fill: Fill; decimals: number };
export type Target = { kind: 'skip' } | { kind: 'metric'; metricId: string } | NewTarget;

export interface ColumnInfo {
  index: number;
  /** Header text, or "Column C" when there is none. */
  header: string;
  kind: ColumnKind;
  /** Non-empty cells below the header. */
  filled: number;
  /** Up to five non-empty cells, for display. */
  sample: Cell[];
  /**
   * Defaults for a new metric made from this column: name and unit from a
   * header like "Weight (kg)" (or a unit written in the cells), decimals
   * seen in the values (max 4), cadence from how often values occur.
   */
  suggested: Omit<NewTarget, 'kind'>;
}

export interface TableAnalysis {
  columns: ColumnInfo[];
  /** First row below the header. */
  dataStart: number;
  suggestedDateColumn: number | null;
  /** Format of the date column (opts.dateColumn, else the suggested one); null if it reads no dates. */
  dateFormat: DateFormat | null;
  /** DD/MM versus MM/DD could not be decided from the values: ask the user. */
  dateAmbiguous: boolean;
  decimal: DecimalSeparator;
}

export interface ImportPlan {
  table: Table;
  headerRow: number | null;
  dateColumn: number;
  dateFormat: DateFormat;
  decimal: DecimalSeparator;
  /** By column index; missing columns are skipped. */
  targets: Record<number, Target>;
  /** What to do when a date already holds a different value. */
  onConflict: 'skip' | 'overwrite';
}

export interface ColumnPreview {
  column: number;
  target: Target;
  /** Distinct dates this column provides a value for (newEntries + conflicts + unchanged). */
  values: number;
  /** Dates the metric has no entry for yet. */
  newEntries: number;
  /** Dates that already hold a different value; onConflict decides. */
  conflicts: number;
  /** Values equal to what is stored (after rounding to the metric's decimals); never rewritten. */
  unchanged: number;
  /** Cells that repeat a date already given earlier in the file; the last one wins. */
  duplicates: number;
  firstDate: ISODate | null;
  lastDate: ISODate | null;
}

export interface ImportPreview {
  perColumn: ColumnPreview[];
  /** Non-empty rows whose date cannot be read. They are skipped. */
  badDates: number[];
  /** Cells in mapped columns that are not numbers. They are skipped. */
  badValues: Array<{ row: number; column: number; raw: Cell }>;
  /** Dates (on the 1st for monthly metrics) given more than once for the same metric. */
  duplicateDates: ISODate[];
  /** Non-empty rows below the header. */
  rows: number;
}

export interface ImportResult {
  metricsCreated: string[];
  entriesWritten: number;
  /** Entries left alone: equal to the stored value, or a conflict with onConflict 'skip'. */
  skipped: number;
}

export type ImportErrorCode = 'bad-plan' | 'unknown-metric';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

const MIN_SHARE = 0.8;
const HEADER_SCAN_ROWS = 30;
const SAMPLE_SIZE = 5;
const MAX_SUGGESTED_DECIMALS = 4;
const DATE_HEADER_RE = /\b(date|fecha|datum|data|day|d[ií]a|jour|giorno|tag|month|mes|mese|mois|monat|time)\b/i;
const UNIT_IN_HEADER_RE = /^(.*?)\s*[([]\s*([^()[\]\s]{1,10})\s*[)\]]\s*$/;
const CADENCES: readonly Cadence[] = ['daily', 'monthly', 'sparse'];
const FILLS: readonly Fill[] = ['none', 'step'];

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** The header row: the nearest non-empty row above the first data-looking row, if it is all text. */
export function guessHeaderRow(table: Table): number | null {
  const rows = table.rows.slice(0, HEADER_SCAN_ROWS);
  const firstData = rows.findIndex(looksLikeData);
  if (firstData < 0) {
    const first = rows.findIndex((r) => !isEmptyRow(r));
    return first >= 0 && isHeaderLike(rows[first]!) ? first : null;
  }
  for (let r = firstData - 1; r >= 0; r--) {
    if (isEmptyRow(rows[r]!)) continue;
    return isHeaderLike(rows[r]!) ? r : null;
  }
  return null;
}

/**
 * Describes every column below the header row. Pass opts.dateColumn when the
 * user picked a date column, to get its format and cadence suggestions.
 */
export function analyzeTable(table: Table, headerRow: number | null, opts: { dateColumn?: number } = {}): TableAnalysis {
  const { rows } = table;
  const dataStart = headerRow === null ? 0 : headerRow + 1;
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const cells: Cell[][] = Array.from({ length: width }, () => []);
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c++) if (!isEmptyCell(row[c])) cells[c]!.push(row[c]!);
  }
  const headerCells = headerRow === null ? [] : (rows[headerRow] ?? []);
  const headers = cells.map((_, c) => cellText(headerCells[c]) || `Column ${columnName(c)}`);

  // Date columns first. Plain numbers are weak evidence (a balance of 45000
  // reads as a 2023 date), so a serial-number column counts only with a
  // date-like header, or as the first day-by-day sequence when nothing else is a date.
  const guesses = cells.map((v) => detectDateFormat(v));
  const strong = guesses.map((g) => g !== null && g.format !== 'serial');
  const isDate = [...strong];
  const anyStrong = strong.some(Boolean);
  let weakTaken = false;
  guesses.forEach((g, c) => {
    if (g?.format !== 'serial') return;
    if (DATE_HEADER_RE.test(headers[c]!) || (!anyStrong && !weakTaken && isDaySequence(cells[c]!))) {
      isDate[c] = true;
      weakTaken = true;
    }
  });
  const firstStrong = isDate.findIndex((d, c) => d && strong[c]);
  const firstDate = isDate.indexOf(true);
  const suggestedDateColumn = firstStrong >= 0 ? firstStrong : firstDate >= 0 ? firstDate : null;
  const dateColumn = opts.dateColumn ?? suggestedDateColumn;
  const guess = dateColumn === null ? null : (guesses[dateColumn] ?? null);

  const decimal = detectDecimalSeparator(cells.flatMap((v, c) => (isDate[c] ? [] : v)));

  // Day number and month index of each data row's date (NaN when unreadable).
  const rowDays: number[] = [];
  const rowMonths: number[] = [];
  let datedRows = 0;
  if (dateColumn !== null && guess) {
    for (let r = dataStart; r < rows.length; r++) {
      const d = parseDate(rows[r]![dateColumn], guess.format);
      rowDays.push(d ? toDayNum(d) : NaN);
      rowMonths.push(d ? Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) : NaN);
      if (d) datedRows++;
    }
  }

  const columns = cells.map((values, c): ColumnInfo => {
    const header = headers[c]!;
    let kind: ColumnKind = 'empty';
    let decimals = 0;
    let numeric = 0;
    const units = new Map<string, number>();
    if (values.length && isDate[c]) kind = 'date';
    else if (values.length) {
      for (const v of values) {
        const p = parseNumberParts(v, { decimal });
        if (!p) continue;
        numeric++;
        decimals = Math.max(decimals, decimalsOf(p.value));
        if (p.unit) units.set(p.unit, (units.get(p.unit) ?? 0) + 1);
      }
      kind = numeric >= values.length * MIN_SHARE ? 'number' : 'text';
    }
    const named = splitHeader(header);
    let unit = named.unit;
    if (!unit) {
      for (const [u, n] of units) if (n * 2 >= numeric && n > (units.get(unit) ?? 0)) unit = u;
    }
    const points: Array<[day: number, month: number]> = [];
    if (c !== dateColumn) {
      for (let i = 0; i < rowDays.length; i++) {
        if (!Number.isNaN(rowDays[i]!) && !isEmptyCell(rows[dataStart + i]![c])) points.push([rowDays[i]!, rowMonths[i]!]);
      }
    }
    return {
      index: c,
      header,
      kind,
      filled: values.length,
      sample: values.slice(0, SAMPLE_SIZE),
      suggested: { name: named.name, unit, decimals, ...suggestCadence(points, guess?.format ?? null, datedRows) },
    };
  });

  return {
    columns,
    dataStart,
    suggestedDateColumn,
    dateFormat: guess?.format ?? null,
    dateAmbiguous: guess?.ambiguous ?? false,
    decimal,
  };
}

function looksLikeData(row: Cell[]): boolean {
  let filled = 0;
  let typed = 0;
  for (const c of row) {
    if (isEmptyCell(c)) continue;
    filled++;
    if (c instanceof Date || typeof c === 'number' || isDateLike(c) || parseNumber(c) !== null) typed++;
  }
  return typed > 0 && typed * 2 >= filled;
}

function isHeaderLike(row: Cell[]): boolean {
  return (
    !isEmptyRow(row) &&
    row.every((c) => isEmptyCell(c) || (typeof c === 'string' && parseNumber(c) === null && !isDateLike(c)))
  );
}

function isEmptyRow(row: Cell[]): boolean {
  return row.every((c) => isEmptyCell(c));
}

function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return parseDate(cell, 'native') ?? '';
  return String(cell).trim();
}

/** "Weight (kg)" → Weight, kg. */
function splitHeader(header: string): { name: string; unit: string } {
  const m = UNIT_IN_HEADER_RE.exec(header);
  return m && m[1] ? { name: m[1], unit: m[2]! } : { name: header, unit: '' };
}

function decimalsOf(n: number): number {
  if (Number.isInteger(n)) return 0;
  const s = String(n);
  const dot = s.indexOf('.');
  return dot < 0 || s.includes('e') ? MAX_SUGGESTED_DECIMALS : Math.min(s.length - dot - 1, MAX_SUGGESTED_DECIMALS);
}

/** Whole-day numbers that move mostly one way in steps of at most a month. */
function isDaySequence(values: Cell[]): boolean {
  let prev: number | null = null;
  let up = 0;
  let down = 0;
  const steps: number[] = [];
  for (const v of values) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) continue;
    const day = Math.floor(n);
    if (prev !== null && day !== prev) {
      if (day > prev) up++;
      else down++;
      steps.push(Math.abs(day - prev));
    }
    prev = day;
  }
  if (!steps.length) return false;
  steps.sort((a, b) => a - b);
  return Math.max(up, down) >= steps.length * 0.9 && steps[steps.length >> 1]! <= 31;
}

/** From the dates a column has values on: one per month → monthly, rarer → sparse (holds until changed). */
function suggestCadence(
  points: Array<[day: number, month: number]>,
  format: DateFormat | null,
  datedRows: number,
): { cadence: Cadence; fill: Fill } {
  const daily = { cadence: 'daily', fill: 'none' } as const;
  const monthly = { cadence: 'monthly', fill: 'none' } as const;
  const sparse = { cadence: 'sparse', fill: 'step' } as const;
  if (format === 'ym' || format === 'my') return monthly;
  points.sort((a, b) => a[0] - b[0]);
  const days: number[] = [];
  let onePerMonth = true;
  let lastMonth = NaN;
  for (const [d, m] of points) {
    if (d === days[days.length - 1]) continue;
    if (m === lastMonth) onePerMonth = false;
    lastMonth = m;
    days.push(d);
  }
  if (days.length === 1 && datedRows > 1) return sparse;
  if (days.length < 2) return daily;
  const gaps = days.slice(1).map((d, i) => d - days[i]!).sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1]!;
  if (onePerMonth && median >= 28 && median <= 31) return monthly;
  return median > 45 ? sparse : daily;
}

// ---------------------------------------------------------------------------
// Preview and apply
// ---------------------------------------------------------------------------

interface Slot {
  column: number;
  target: Target;
  /** Columns writing to the same metric share a key, so the last value per date wins across them too. */
  key: string;
  /** Existing metric, or null for a new one. */
  metric: MetricDef | null;
  spec: NewTarget | null;
  cadence: Cadence;
  decimals: number;
}

interface Collected {
  slots: Slot[];
  values: Map<string, Map<ISODate, { value: number; column: number }>>;
  duplicates: Map<number, number>;
  duplicateDates: Set<ISODate>;
  badDates: number[];
  badValues: Array<{ row: number; column: number; raw: Cell }>;
  rows: number;
}

/** What applyImport would do, without writing anything. */
export function previewImport(vault: Vault, plan: ImportPlan): ImportPreview {
  const c = collect(vault, plan);
  const stats = new Map<number, ColumnPreview>();
  for (const s of c.slots) {
    stats.set(s.column, {
      column: s.column,
      target: s.target,
      values: 0,
      newEntries: 0,
      conflicts: 0,
      unchanged: 0,
      duplicates: c.duplicates.get(s.column) ?? 0,
      firstDate: null,
      lastDate: null,
    });
  }
  const slotByKey = new Map(c.slots.map((s) => [s.key, s]));
  for (const [key, byDate] of c.values) {
    const slot = slotByKey.get(key)!;
    for (const [date, { value, column }] of byDate) {
      const st = stats.get(column)!;
      st.values++;
      if (st.firstDate === null || date < st.firstDate) st.firstDate = date;
      if (st.lastDate === null || date > st.lastDate) st.lastDate = date;
      const existing = slot.metric ? getEntry(vault, slot.metric, date) : undefined;
      if (!existing) st.newEntries++;
      else if (rounded(value, slot.decimals) === existing.value) st.unchanged++;
      else st.conflicts++;
    }
  }
  return {
    perColumn: [...stats.values()].sort((a, b) => a.column - b.column),
    badDates: c.badDates,
    badValues: c.badValues,
    duplicateDates: [...c.duplicateDates].sort(),
    rows: c.rows,
  };
}

/** Creates the new metrics and writes the values in a single vault batch. Existing notes are kept. */
export function applyImport(vault: Vault, plan: ImportPlan): ImportResult {
  const c = collect(vault, plan);
  const metricsCreated: string[] = [];
  let entriesWritten = 0;
  let skipped = 0;
  vault.batch(() => {
    const defs = new Map<string, MetricDef>();
    const used = usedSlugs(vault);
    let order = nextOrder(metrics(vault, { includeArchived: true }));
    for (const s of c.slots) {
      if (defs.has(s.key)) continue;
      if (s.metric) {
        defs.set(s.key, s.metric);
        continue;
      }
      const def = newMetricDef(s.spec!, used, order++);
      saveMetric(vault, def);
      metricsCreated.push(def.id);
      defs.set(s.key, def);
    }
    for (const [key, byDate] of c.values) {
      const m = defs.get(key)!;
      const fresh = metricsCreated.includes(m.id);
      for (const [date, { value }] of byDate) {
        const existing = fresh ? undefined : getEntry(vault, m, date);
        if (existing && (plan.onConflict === 'skip' || rounded(value, m.decimals) === existing.value)) {
          skipped++;
          continue;
        }
        setEntry(vault, m, date, value, existing?.note);
        entriesWritten++;
      }
    }
  });
  return { metricsCreated, entriesWritten, skipped };
}

function collect(vault: Vault, plan: ImportPlan): Collected {
  const slots = resolveTargets(vault, plan);
  const out: Collected = {
    slots,
    values: new Map(slots.map((s) => [s.key, new Map()])),
    duplicates: new Map(),
    duplicateDates: new Set(),
    badDates: [],
    badValues: [],
    rows: 0,
  };
  const { rows } = plan.table;
  const hint = { decimal: plan.decimal };
  for (let r = plan.headerRow === null ? 0 : plan.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (isEmptyRow(row)) continue;
    out.rows++;
    const date = parseDate(row[plan.dateColumn], plan.dateFormat);
    if (!date) {
      out.badDates.push(r);
      continue;
    }
    for (const s of slots) {
      const raw = row[s.column] ?? null;
      if (isEmptyCell(raw)) continue;
      const value = parseNumber(raw, hint);
      if (value === null) {
        out.badValues.push({ row: r, column: s.column, raw });
        continue;
      }
      const d = s.cadence === 'monthly' ? entryDate(s, date) : date;
      const byDate = out.values.get(s.key)!;
      if (byDate.has(d)) {
        out.duplicates.set(s.column, (out.duplicates.get(s.column) ?? 0) + 1);
        out.duplicateDates.add(d);
      }
      byDate.set(d, { value, column: s.column });
    }
  }
  return out;
}

function resolveTargets(vault: Vault, plan: ImportPlan): Slot[] {
  if (!Number.isInteger(plan.dateColumn) || plan.dateColumn < 0) {
    throw new ImportError('bad-plan', 'Choose the column that holds the dates.');
  }
  if (!DATE_FORMATS.includes(plan.dateFormat)) throw new ImportError('bad-plan', 'Choose how the dates are written.');
  const slots: Slot[] = [];
  for (const [k, target] of Object.entries(plan.targets)) {
    const column = Number(k);
    if (!target || target.kind === 'skip') continue;
    if (!Number.isInteger(column) || column < 0) throw new ImportError('bad-plan', `There is no column "${k}".`);
    if (column === plan.dateColumn) {
      throw new ImportError('bad-plan', 'The date column cannot also be imported as values.');
    }
    if (target.kind === 'metric') {
      const m = metric(vault, target.metricId);
      if (!m) throw new ImportError('unknown-metric', 'One of the chosen metrics no longer exists.');
      slots.push({ column, target, key: `m:${m.id}`, metric: m, spec: null, cadence: m.cadence, decimals: m.decimals });
    } else {
      if (!target.name.trim()) {
        throw new ImportError('bad-plan', `Give the new metric for column ${columnName(column)} a name.`);
      }
      if (!CADENCES.includes(target.cadence) || !FILLS.includes(target.fill)) {
        throw new ImportError('bad-plan', `Choose how often the new metric for column ${columnName(column)} is entered.`);
      }
      const decimals = clampDecimals(target.decimals);
      slots.push({ column, target, key: `n:${column}`, metric: null, spec: target, cadence: target.cadence, decimals });
    }
  }
  return slots.sort((a, b) => a.column - b.column);
}

function newMetricDef(spec: NewTarget, used: Set<string>, order: number): MetricDef {
  const name = spec.name.trim();
  const base = slugify(name);
  // uniqueSlug appends "_2", "_3"…: leave room for it within the 40-character limit.
  const slug = used.has(base) ? uniqueSlug(base.slice(0, 36), used) : base;
  used.add(slug);
  const decimals = clampDecimals(spec.decimals);
  const def: MetricDef = {
    id: newId(),
    slug,
    name,
    unit: spec.unit.trim(),
    cadence: spec.cadence,
    fill: spec.fill,
    decimals,
    step: Number((10 ** -decimals).toFixed(decimals)),
    order,
  };
  if (spec.cadence === 'sparse') def.hideFromToday = true;
  return def;
}

function clampDecimals(d: number): number {
  return Number.isFinite(d) ? Math.min(Math.max(Math.round(d), 0), 10) : 0;
}

/** Same rounding as repo.setEntry. */
function rounded(value: number, decimals: number): number {
  const factor = 10 ** Math.min(Math.max(decimals, 0), 10);
  return Math.round(value * factor) / factor;
}
