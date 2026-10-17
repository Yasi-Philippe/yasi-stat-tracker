/**
 * Raw tables from files the user picks: CSV/TSV text and .xlsx workbooks.
 * Cells keep their original form (text stays text), so the importer can
 * decide how to read numbers and dates with evidence from a whole column
 * instead of guessing one cell at a time.
 */

/** One raw cell. Empty cells are null; text is trimmed. */
export type Cell = string | number | Date | boolean | null;

export interface Table {
  /** Sheet name, or the file name without its extension for text files. */
  name: string;
  /** Rows of cells, padded with null to the same length. rows[0] is the first line / sheet row 1. */
  rows: Cell[][];
}

export type Delimiter = ',' | ';' | '\t' | '|';

export type TableReadErrorCode =
  /** Nothing to read. */
  | 'empty'
  /** Legacy binary Excel file (.xls). */
  | 'legacy-xls'
  /** Password-protected workbook. */
  | 'protected'
  /** Not a spreadsheet or text table (image, PDF, .ods…). */
  | 'unsupported'
  /** Looks like a workbook but cannot be read. */
  | 'corrupt';

/** A file that cannot be read as a table, with a message written for people. */
export class TableReadError extends Error {
  constructor(
    readonly code: TableReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TableReadError';
  }
}

export function isEmptyCell(cell: Cell | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/** Spreadsheet-style column name: 0 → "A", 25 → "Z", 26 → "AA". */
export function columnName(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

const QUOTE = 34;
const LF = 10;
const CR = 13;
const SPACE = 32;

/** Candidates in tie-break order: a tab or semicolon that splits every line evenly beats a comma (decimal commas). */
const CANDIDATES: readonly Delimiter[] = ['\t', ';', ',', '|'];
const SAMPLE_CHARS = 64 * 1024;
const SAMPLE_ROWS = 200;

/**
 * Parses CSV, TSV or semicolon-separated text. Handles quotes, doubled
 * quotes, line breaks inside quotes, CRLF/LF/CR, a byte order mark, Excel's
 * "sep=;" first line and trailing empty lines. The delimiter is detected
 * unless given.
 */
export function parseDelimited(text: string, opts: { name?: string; delimiter?: Delimiter } = {}): Table {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let delimiter: string | undefined = opts.delimiter;
  const hint = /^sep=([^\r\n])[ \t]*(?:\r\n|\n|\r|$)/i.exec(src);
  if (hint) {
    src = src.slice(hint[0].length);
    delimiter ??= hint[1];
  }
  const raw = splitRecords(src, delimiter ?? detectDelimiter(src));
  const rows = raw.map((r) => r.map(textCell));
  return { name: opts.name ?? 'Sheet1', rows: rectangular(rows) };
}

/** Picks the delimiter that splits the first lines most consistently. Defaults to a comma. */
export function detectDelimiter(text: string): Delimiter {
  let sample = text;
  if (text.length > SAMPLE_CHARS) {
    const cut = text.lastIndexOf('\n', SAMPLE_CHARS);
    sample = text.slice(0, cut > 0 ? cut : SAMPLE_CHARS);
  }
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = new Map<number, number>();
    let lines = 0;
    for (const r of splitRecords(sample, d, SAMPLE_ROWS)) {
      if (r.length === 1 && r[0]!.trim() === '') continue;
      lines++;
      counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    }
    let mode = 1;
    let modeLines = 0;
    for (const [fields, n] of counts) {
      if (n > modeLines || (n === modeLines && fields > mode)) {
        mode = fields;
        modeLines = n;
      }
    }
    if (mode < 2) continue;
    const score = modeLines / lines;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function splitRecords(src: string, delimiter: string, maxRows = Infinity): string[][] {
  const d = delimiter.charCodeAt(0);
  const n = src.length;
  const rows: string[][] = [];
  if (n === 0) return rows;
  let row: string[] = [];
  let i = 0;
  for (;;) {
    let field: string;
    let j = i;
    while (j < n && src.charCodeAt(j) === SPACE) j++;
    if (j < n && src.charCodeAt(j) === QUOTE) {
      field = '';
      let k = j + 1;
      for (;;) {
        const q = src.indexOf('"', k);
        if (q < 0) {
          // Unterminated quote: keep the rest of the text rather than losing it.
          field += src.slice(k);
          i = n;
          break;
        }
        field += src.slice(k, q);
        if (src.charCodeAt(q + 1) === QUOTE) {
          field += '"';
          k = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
      const end = fieldEnd(src, i, d);
      if (end > i) field += src.slice(i, end);
      i = end;
    } else {
      const end = fieldEnd(src, i, d);
      field = src.slice(i, end);
      i = end;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    if (src.charCodeAt(i) === d) {
      i++;
      if (i >= n) {
        row.push('');
        rows.push(row);
        break;
      }
      continue;
    }
    i += src.charCodeAt(i) === CR && src.charCodeAt(i + 1) === LF ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n || rows.length >= maxRows) break;
  }
  return rows;
}

function fieldEnd(src: string, from: number, d: number): number {
  let e = from;
  for (; e < src.length; e++) {
    const c = src.charCodeAt(e);
    if (c === d || c === LF || c === CR) break;
  }
  return e;
}

function textCell(s: string): Cell {
  const t = s.trim();
  return t === '' ? null : t;
}

/** Drops trailing empty rows and pads every row with null to the same width. */
function rectangular(rows: Cell[][]): Cell[][] {
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.every((c) => isEmptyCell(c))) end--;
  const out = end === rows.length ? rows : rows.slice(0, end);
  const width = out.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of out) while (r.length < width) r.push(null);
  return out;
}

// ---------------------------------------------------------------------------
// Bytes to text
// ---------------------------------------------------------------------------

/**
 * Decodes a text file: UTF-8 (BOM stripped), UTF-16 with a BOM (Excel's
 * "Unicode text"), otherwise Windows-1252 when the bytes are not valid UTF-8.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** OLE compound file: legacy .xls, and also password-protected .xlsx. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Reads a file the user picked. Workbooks (.xlsx, detected by content) give
 * one table per sheet, with date cells as Date objects at UTC midnight;
 * anything else is decoded as delimited text and gives one table.
 * Throws TableReadError with a message to show.
 */
export async function readSpreadsheet(bytes: Uint8Array, fileName: string): Promise<Table[]> {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base) || 'Data';
  if (bytes.length === 0) throw new TableReadError('empty', 'The file is empty.');

  let tables: Table[];
  if (startsWith(bytes, OLE_MAGIC)) {
    if (ext === 'xlsx' || ext === 'xlsm') {
      throw new TableReadError(
        'protected',
        'This workbook is password-protected. Remove the password in your spreadsheet app, save it, and try again.',
      );
    }
    throw new TableReadError(
      'legacy-xls',
      'This is an old Excel file (.xls). Open it in your spreadsheet app and save it as .xlsx or CSV.',
    );
  } else if (startsWith(bytes, ZIP_MAGIC)) {
    if (ext === 'ods' || latin1(bytes.subarray(0, 200)).includes('opendocument')) {
      throw new TableReadError('unsupported', 'OpenDocument spreadsheets are not supported. Save it as .xlsx or CSV.');
    }
    tables = await readXlsx(bytes);
  } else {
    const text = decodeText(bytes);
    if (text.slice(0, 4096).includes('\u0000')) {
      throw new TableReadError('unsupported', 'This file is not a spreadsheet or CSV file.');
    }
    tables = [parseDelimited(text, { name: stem })];
  }
  if (tables.every((t) => t.rows.length === 0)) throw new TableReadError('empty', 'The file has no data.');
  return tables;
}

async function readXlsx(bytes: Uint8Array): Promise<Table[]> {
  // Loaded on demand: the workbook reader is only needed when a workbook is opened.
  const { default: readXlsxFile } = await import('read-excel-file/universal');
  let sheets: Array<{ sheet: string; data: unknown[][] }>;
  try {
    sheets = await readXlsxFile(bytes.slice().buffer);
  } catch {
    throw new TableReadError(
      'corrupt',
      'This workbook could not be read. Open it in your spreadsheet app, save it again as .xlsx or CSV, and retry.',
    );
  }
  return sheets.map((s) => ({ name: s.sheet, rows: rectangular(s.data.map((r) => r.map(workbookCell))) }));
}

function workbookCell(v: unknown): Cell {
  if (typeof v === 'string') return textCell(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  return null;
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
