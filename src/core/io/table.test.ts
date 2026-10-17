import { describe, expect, it } from 'vitest';
import { columnName, decodeText, detectDelimiter, parseDelimited, readSpreadsheet, TableReadError } from './table';

const enc = new TextEncoder();

describe('parseDelimited', () => {
  it('reads comma-separated text with quotes, escaped quotes and line breaks inside quotes', () => {
    const t = parseDelimited('date,note,value\r\n2024-01-01,"a, b",1\r\n2024-01-02,"say ""hi""\nthere",2\r\n');
    expect(t.rows).toEqual([
      ['date', 'note', 'value'],
      ['2024-01-01', 'a, b', '1'],
      ['2024-01-02', 'say "hi"\nthere', '2'],
    ]);
  });

  it('detects semicolons in European files even without a header', () => {
    expect(parseDelimited('01/02/2024;80,5;20,1\n02/02/2024;80,1;20\n').rows).toEqual([
      ['01/02/2024', '80,5', '20,1'],
      ['02/02/2024', '80,1', '20'],
    ]);
    expect(parseDelimited('fecha;peso\n01/02/2024;80,5\n').rows[1]).toEqual(['01/02/2024', '80,5']);
  });

  it('detects tabs and pipes', () => {
    expect(parseDelimited('a\tb\n1,5\t2\n').rows).toEqual([
      ['a', 'b'],
      ['1,5', '2'],
    ]);
    expect(parseDelimited('a|b\n1|2\n').rows[1]).toEqual(['1', '2']);
  });

  it('strips a BOM, trims cells, maps empty cells to null and pads ragged rows', () => {
    const t = parseDelimited('﻿a,b,c\n 1 ,,\n2\n\n\n', { name: 'x' });
    expect(t.name).toBe('x');
    expect(t.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', null, null],
      ['2', null, null],
    ]);
  });

  it('keeps empty lines in the middle so row numbers match the file', () => {
    expect(parseDelimited('a,b\n\n1,2').rows).toEqual([
      ['a', 'b'],
      [null, null],
      ['1', '2'],
    ]);
  });

  it("honours Excel's sep= line and an explicit delimiter", () => {
    expect(parseDelimited('sep=;\na;b,c\n').rows).toEqual([['a', 'b,c']]);
    expect(parseDelimited('a;b,c\n', { delimiter: ',' }).rows).toEqual([['a;b', 'c']]);
  });

  it('handles CR-only line ends, a trailing delimiter and an unterminated quote', () => {
    expect(parseDelimited('a,b\r1,2\r').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('a,').rows).toEqual([['a', null]]);
    expect(parseDelimited('a,"b\nc').rows).toEqual([['a', 'b\nc']]);
  });

  it('returns no rows for empty text', () => {
    expect(parseDelimited('').rows).toEqual([]);
    expect(parseDelimited('\n\r\n').rows).toEqual([]);
  });
});

describe('detectDelimiter', () => {
  it('prefers the delimiter that splits every line the same way', () => {
    expect(detectDelimiter('date,tags\n2024-01-01,run;gym\n2024-01-02,swim;bike\n')).toBe(',');
    expect(detectDelimiter('date;value\n2024-01-01;1,5\n2024-01-02;2\n')).toBe(';');
    expect(detectDelimiter('single column\n1\n2\n')).toBe(',');
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 and strips its BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('café,€')]))).toBe('café,€');
  });

  it('falls back to Windows-1252 for bytes that are not UTF-8', () => {
    // "café;€5" as saved by older Windows spreadsheet apps.
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x3b, 0x80, 0x35]))).toBe('café;€5');
  });

  it('decodes UTF-16 with a BOM', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x09, 0x00, 0xe9, 0x00]);
    expect(decodeText(le)).toBe('a\té');
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0x09, 0x00, 0xe9]);
    expect(decodeText(be)).toBe('a\té');
  });
});

describe('columnName', () => {
  it('names columns like a spreadsheet', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
});

// ---------------------------------------------------------------------------
// A minimal .xlsx written by hand: a zip (stored, no compression) of the
// few XML parts a workbook reader needs.
// ---------------------------------------------------------------------------

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const entry = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function workbook(): Uint8Array {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Log" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${NS}" count="2" uniqueCount="2"><si><t>Date</t></si><si><t>Weight (kg)</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Done</t></is></c></row>
      <row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2"><v>80.5</v></c><c r="C2" t="b"><v>1</v></c></row>
      <row r="4"><c r="A4" s="1"><v>45294.75</v></c><c r="B4"><v>80.25</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData/></worksheet>`,
  });
}

describe('readSpreadsheet', () => {
  it('reads every sheet of an .xlsx, with date cells as Dates at UTC midnight', async () => {
    const tables = await readSpreadsheet(workbook(), 'export.xlsx');
    expect(tables.map((t) => t.name)).toEqual(['Log', 'Empty']);
    expect(tables[0]!.rows).toEqual([
      ['Date', 'Weight (kg)', 'Done'],
      [new Date('2024-01-01T00:00:00Z'), 80.5, true],
      [null, null, null],
      [new Date('2024-01-03T18:00:00Z'), 80.25, null],
    ]);
    expect(tables[1]!.rows).toEqual([]);
  });

  it('reads text files as one table named after the file', async () => {
    const tables = await readSpreadsheet(enc.encode('a;b\n1;2\n'), '/some/dir/My log.v2.csv');
    expect(tables).toEqual([{ name: 'My log.v2', rows: [['a', 'b'], ['1', '2']] }]);
  });

  it('explains files it cannot read', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof TableReadError ? e.code : 'other'));
    expect(await code(readSpreadsheet(ole, 'old.xls'))).toBe('legacy-xls');
    expect(await code(readSpreadsheet(ole, 'locked.xlsx'))).toBe('protected');
    expect(await code(readSpreadsheet(new Uint8Array(0), 'x.csv'))).toBe('empty');
    expect(await code(readSpreadsheet(enc.encode('\n\n'), 'x.csv'))).toBe('empty');
    expect(await code(readSpreadsheet(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'a.png'))).toBe('unsupported');
    const broken = workbook().slice(0, 300);
    expect(await code(readSpreadsheet(broken, 'broken.xlsx'))).toBe('corrupt');
    const notXlsx = zip({ 'mimetype': 'application/zip', 'readme.xml': '<a/>' });
    expect(await code(readSpreadsheet(notXlsx, 'archive.zip'))).toBe('corrupt');
  });
});
