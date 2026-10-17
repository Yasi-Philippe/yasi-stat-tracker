import { ClipboardPaste, FileUp, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { metrics } from '@/core/data/repo';
import {
  analyzeTable,
  applyImport,
  guessHeaderRow,
  type ImportPlan,
  type NewTarget,
  previewImport,
  type Target,
} from '@/core/io/importer';
import type { DateFormat, DecimalSeparator } from '@/core/io/parse';
import { type Cell, columnName, parseDelimited, readSpreadsheet, type Table } from '@/core/io/table';
import type { Cadence, Fill } from '@/core/model/types';
import { platform } from '@/platform';
import { Segmented, Select, TextField } from '../components/Controls';
import { toast, toastError } from '../components/Toast';
import { fmtDay } from '../format';
import { Section, StudioPage } from './common';

type Step = 'source' | 'structure' | 'preview';

const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  ymd: 'Year-month-day (2024-03-31)',
  dmy: 'Day/month/year (31/03/2024)',
  mdy: 'Month/day/year (03/31/2024)',
  ym: 'Year-month (2024-03)',
  my: 'Month/year (03/2024)',
  native: 'Spreadsheet dates',
  serial: 'Spreadsheet day numbers',
};

function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c);
}

export function ImportSection() {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [tableIndex, setTableIndex] = useState(0);
  const [paste, setPaste] = useState('');
  const [step, setStep] = useState<Step>('source');
  const [busy, setBusy] = useState(false);
  const table = tables?.[tableIndex] ?? null;

  const loadFile = async () => {
    const f = await platform().files.open(['.csv', '.tsv', '.txt', '.xlsx', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    if (!f) return;
    setBusy(true);
    try {
      const list = await readSpreadsheet(f.bytes, f.name);
      setTables(list);
      setTableIndex(0);
      setStep('structure');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StudioPage title={<em>Import</em>}>
      {step === 'source' && (
        <div className="studio-form">
          <p className="muted small" style={{ marginTop: -8, marginBottom: 16 }}>
            Bring history in from a spreadsheet. The file is read on this device only; nothing is uploaded until it becomes your encrypted data.
          </p>
          <Section title="From a file">
            <button className="btn primary lg block" disabled={busy} onClick={() => void loadFile()}>
              {busy ? <span className="spinner" /> : <FileUp size={18} />} Choose CSV or Excel file
            </button>
            <p className="tiny faint">.xlsx, .csv, .tsv or .txt. Old .xls files: save them as .xlsx first.</p>
          </Section>
          <Section title="Or paste">
            <textarea
              className="textarea mono-input"
              rows={6}
              placeholder={'Copy cells from a spreadsheet and paste them here.\nDate\tWeight\n2024-01-01\t80.5'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <button
              className="btn block"
              disabled={!paste.trim()}
              onClick={() => {
                try {
                  setTables([parseDelimited(paste, { name: 'Pasted' })]);
                  setTableIndex(0);
                  setStep('structure');
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              <ClipboardPaste size={16} /> Use pasted data
            </button>
          </Section>
        </div>
      )}
      {step !== 'source' && table && tables && (
        <Wizard
          key={`${tableIndex}`}
          table={table}
          tables={tables}
          tableIndex={tableIndex}
          onTable={setTableIndex}
          step={step}
          setStep={setStep}
          onRestart={() => {
            setTables(null);
            setStep('source');
          }}
        />
      )}
    </StudioPage>
  );
}

function Wizard({
  table,
  tables,
  tableIndex,
  onTable,
  step,
  setStep,
  onRestart,
}: {
  table: Table;
  tables: Table[];
  tableIndex: number;
  onTable: (i: number) => void;
  step: Step;
  setStep: (s: Step) => void;
  onRestart: () => void;
}) {
  const { vault, version } = useVault();
  const existing = useMemo(() => metrics(vault, { includeArchived: true }), [vault, version]);
  const [headerRow, setHeaderRow] = useState<number | null>(() => guessHeaderRow(table));
  const [dateColumn, setDateColumn] = useState<number | null>(null);
  const analysis = useMemo(() => analyzeTable(table, headerRow, dateColumn === null ? undefined : { dateColumn }), [table, headerRow, dateColumn]);
  const effectiveDateCol = dateColumn ?? analysis.suggestedDateColumn;
  const [dateFormat, setDateFormat] = useState<DateFormat | null>(null);
  const [decimal, setDecimal] = useState<DecimalSeparator | null>(null);
  const [targets, setTargets] = useState<Record<number, Target>>({});
  const [onConflict, setOnConflict] = useState<'skip' | 'overwrite'>('skip');

  const fmt = dateFormat ?? analysis.dateFormat ?? 'ymd';
  const dec = decimal ?? analysis.decimal;
  const valueColumns = analysis.columns.filter((c) => c.index !== effectiveDateCol && c.kind !== 'empty');
  const targetOf = (i: number): Target => targets[i] ?? defaultTarget(analysis.columns[i]!, existing);

  const plan: ImportPlan | null =
    effectiveDateCol === null
      ? null
      : {
          table,
          headerRow,
          dateColumn: effectiveDateCol,
          dateFormat: fmt,
          decimal: dec,
          targets: Object.fromEntries(valueColumns.map((c) => [c.index, targetOf(c.index)])),
          onConflict,
        };
  const preview = useMemo(() => (plan && step === 'preview' ? previewImport(vault, plan) : null), [plan, step, vault]);

  const rows = table.rows.slice(analysis.dataStart, analysis.dataStart + 6);
  const width = Math.min(table.rows[0]?.length ?? 0, 8);

  return (
    <div className="studio-form">
      {step === 'structure' && (
        <>
          {tables.length > 1 && (
            <Section title="Sheet">
              <Select label="Sheet" value={String(tableIndex)} onChange={(v) => onTable(Number(v))} options={tables.map((t, i) => ({ value: String(i), label: `${t.name} (${t.rows.length} rows)` }))} />
            </Section>
          )}
          <Section title="What the table looks like">
            <div className="import-table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    {Array.from({ length: width }, (_, i) => (
                      <th key={i} className={i === effectiveDateCol ? 'is-date' : ''}>
                        {columnName(i)}
                        <span>{analysis.columns[i]?.header || ''}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, ri) => (
                    <tr key={ri}>
                      {Array.from({ length: width }, (_, i) => (
                        <td key={i}>{cellText(r[i])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row wrap">
              <div className="grow">
                <Select
                  label="Header row"
                  value={headerRow === null ? 'none' : String(headerRow)}
                  onChange={(v) => setHeaderRow(v === 'none' ? null : Number(v))}
                  options={[{ value: 'none', label: 'No header row' }, ...table.rows.slice(0, 10).map((_, i) => ({ value: String(i), label: `Row ${i + 1}` }))]}
                />
              </div>
              <div className="grow">
                <Select
                  label="Date column"
                  value={effectiveDateCol === null ? '' : String(effectiveDateCol)}
                  onChange={(v) => setDateColumn(v === '' ? null : Number(v))}
                  options={[{ value: '', label: 'Choose…' }, ...analysis.columns.map((c) => ({ value: String(c.index), label: `${columnName(c.index)} · ${c.header || c.kind}` }))]}
                />
              </div>
            </div>
            <div className="row wrap">
              <div className="grow">
                <Select label="Dates are written as" value={fmt} onChange={(v) => setDateFormat(v)} options={(Object.keys(DATE_FORMAT_LABELS) as DateFormat[]).map((f) => ({ value: f, label: DATE_FORMAT_LABELS[f] }))} />
              </div>
              <div className="field">
                <span className="field-label">Decimal mark</span>
                <Segmented value={dec} onChange={setDecimal} options={[{ value: '.', label: '1.5' }, { value: ',', label: '1,5' }]} />
              </div>
            </div>
            {analysis.dateAmbiguous && dateFormat === null && (
              <div className="callout warn">
                <Table2 size={18} />
                <span>These dates could be day/month or month/day. Please pick the right one above.</span>
              </div>
            )}
          </Section>

          <Section title="Where each column goes">
            {valueColumns.length === 0 && <p className="small muted">No value columns found.</p>}
            {valueColumns.map((c) => {
              const t = targetOf(c.index);
              const sel = t.kind === 'skip' ? 'skip' : t.kind === 'new' ? 'new' : t.metricId;
              return (
                <div key={c.index} className="series-block">
                  <div className="spread">
                    <b>
                      {columnName(c.index)} · {c.header || 'Untitled'}
                    </b>
                    <span className="tiny muted">
                      {c.filled} values · e.g. {c.sample.slice(0, 3).map(cellText).join(', ')}
                    </span>
                  </div>
                  <Select
                    label="Import into"
                    value={sel}
                    onChange={(v) =>
                      setTargets({
                        ...targets,
                        [c.index]: v === 'skip' ? { kind: 'skip' } : v === 'new' ? { kind: 'new', ...c.suggested } : { kind: 'metric', metricId: v },
                      })
                    }
                    options={[
                      { value: 'skip', label: 'Skip this column' },
                      { value: 'new', label: 'A new metric' },
                      ...existing.map((m) => ({ value: m.id, label: `${m.name} (${m.unit || 'no unit'})` })),
                    ]}
                  />
                  {t.kind === 'new' && <NewMetricFields value={t} onChange={(nt) => setTargets({ ...targets, [c.index]: nt })} />}
                </div>
              );
            })}
          </Section>
          <div className="save-bar">
            <button className="btn ghost" onClick={onRestart}>
              Start over
            </button>
            <button className="btn primary" disabled={!plan} onClick={() => setStep('preview')}>
              Preview
            </button>
          </div>
        </>
      )}

      {step === 'preview' && preview && plan && (
        <>
          <Section title="What will happen">
            {preview.perColumn
              .filter((p) => p.target.kind !== 'skip')
              .map((p) => {
                const name = p.target.kind === 'new' ? `${p.target.name} (new)` : p.target.kind === 'metric' ? existing.find((m) => m.id === (p.target as { metricId: string }).metricId)?.name : '';
                return (
                  <div key={p.column} className="spread import-row">
                    <span>
                      <b>{name}</b>
                      <span className="tiny muted" style={{ display: 'block' }}>
                        {p.firstDate ? `${fmtDay(p.firstDate, 'medium')} → ${fmtDay(p.lastDate!, 'medium')}` : 'No dates'}
                      </span>
                    </span>
                    <span className="small" style={{ textAlign: 'right' }}>
                      <b className="num">{p.newEntries}</b> new
                      {p.conflicts > 0 && <span className="neg"> · {p.conflicts} differ from what you have</span>}
                      {p.unchanged > 0 && <span className="muted"> · {p.unchanged} identical</span>}
                    </span>
                  </div>
                );
              })}
            {(preview.badDates.length > 0 || preview.badValues.length > 0) && (
              <div className="callout warn">
                <Table2 size={18} />
                <span>
                  {preview.badDates.length > 0 && `${preview.badDates.length} rows have no readable date (e.g. row ${preview.badDates[0]! + 1}). `}
                  {preview.badValues.length > 0 && `${preview.badValues.length} cells are not numbers and will be skipped.`}
                </span>
              </div>
            )}
            {preview.perColumn.some((p) => p.conflicts > 0) && (
              <div className="field">
                <span className="field-label">When a day already has a different value</span>
                <Segmented
                  value={onConflict}
                  onChange={setOnConflict}
                  options={[
                    { value: 'skip', label: 'Keep mine' },
                    { value: 'overwrite', label: 'Use the file' },
                  ]}
                />
              </div>
            )}
          </Section>
          <div className="save-bar">
            <button className="btn ghost" onClick={() => setStep('structure')}>
              Back
            </button>
            <button
              className="btn primary"
              onClick={() => {
                try {
                  const r = applyImport(vault, plan);
                  toast(`Imported ${r.entriesWritten} values${r.metricsCreated.length ? ` into ${r.metricsCreated.length} new metrics` : ''}`);
                  navigate({ name: 'studio', section: 'metrics' });
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              Import
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function defaultTarget(c: { kind: string; suggested: Omit<NewTarget, 'kind'>; header: string }, existing: Array<{ id: string; name: string; slug: string }>): Target {
  if (c.kind !== 'number') return { kind: 'skip' };
  const h = c.header.toLowerCase().trim();
  const match = existing.find((m) => h && (m.name.toLowerCase() === h || m.slug === h));
  return match ? { kind: 'metric', metricId: match.id } : { kind: 'new', ...c.suggested };
}

function NewMetricFields({ value, onChange }: { value: NewTarget; onChange: (t: NewTarget) => void }) {
  return (
    <div className="stack-12">
      <div className="row">
        <div className="grow">
          <TextField label="Name" value={value.name} onChange={(name) => onChange({ ...value, name })} />
        </div>
        <div style={{ width: 110 }}>
          <TextField label="Unit" value={value.unit} onChange={(unit) => onChange({ ...value, unit })} />
        </div>
      </div>
      <div className="row wrap">
        <Segmented<Cadence>
          value={value.cadence}
          onChange={(cadence) => onChange({ ...value, cadence, fill: cadence === 'sparse' ? 'step' : value.fill })}
          options={[
            { value: 'daily', label: 'Daily' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'sparse', label: 'Occasional' },
          ]}
        />
        <Segmented<Fill>
          value={value.fill}
          onChange={(fill) => onChange({ ...value, fill })}
          options={[
            { value: 'none', label: 'Gaps stay gaps' },
            { value: 'step', label: 'Holds value' },
          ]}
        />
        <Segmented value={String(value.decimals)} onChange={(d) => onChange({ ...value, decimals: Number(d) })} options={['0', '1', '2', '3'].map((d) => ({ value: d, label: `${d} dp` }))} />
      </div>
    </div>
  );
}
