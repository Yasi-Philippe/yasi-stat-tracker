import { type ReactNode, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sheet } from './Sheet';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  accent,
  block,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  accent?: boolean;
  block?: boolean;
  label?: string;
}) {
  return (
    <div className={`seg${accent ? ' accent' : ''}${block ? ' block' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

export function ToggleRow({ title, sub, checked, onChange }: { title: ReactNode; sub?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="spread" style={{ minHeight: 48, cursor: 'pointer' }}>
      <span className="grow">
        <span style={{ fontWeight: 650, display: 'block' }}>{title}</span>
        {sub && <span className="small muted">{sub}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={typeof title === 'string' ? title : 'toggle'} />
    </label>
  );
}

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  type = 'text',
  inputMode,
  autoFocus,
  autoComplete,
  mono,
  maxLength,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: ReactNode;
  placeholder?: string;
  type?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'email';
  autoFocus?: boolean;
  autoComplete?: string;
  mono?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={`input${error ? ' invalid' : ''}${mono ? ' mono-input' : ''}`}
        value={value}
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: ReactNode;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export const SWATCHES = [
  '#C6F432', '#3DDC97', '#2DD4BF', '#38BDF8', '#3563E9', '#7C5CFF', '#A78BFA', '#F472B6',
  '#FF5D73', '#FF8A4C', '#FACC15', '#E4572E', '#8B8F9C', '#F2F1EC', '#1B1914', '#0A0B0F',
];

export function ColorPicker({ value, onChange, allowNone }: { value: string | null | undefined; onChange: (v: string | null) => void; allowNone?: boolean }) {
  const [custom, setCustom] = useState(value ?? '');
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="color-grid">
        {allowNone && (
          <button
            type="button"
            aria-pressed={!value}
            title="Automatic"
            onClick={() => onChange(null)}
            style={{ background: 'conic-gradient(var(--accent), var(--accent-2), var(--accent))' }}
          />
        )}
        {SWATCHES.map((c) => (
          <button type="button" key={c} aria-pressed={value?.toLowerCase() === c.toLowerCase()} style={{ background: c }} title={c} onClick={() => onChange(c)} />
        ))}
      </div>
      <div className="row">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(custom) ? custom : '#888888'} onChange={(e) => (setCustom(e.target.value), onChange(e.target.value))} style={{ width: 44, height: 36, border: 0, background: 'none', padding: 0 }} aria-label="Custom colour" />
        <input
          className="input mono-input"
          style={{ minHeight: 36 }}
          value={custom}
          placeholder="#RRGGBB"
          onChange={(e) => {
            setCustom(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value);
          }}
        />
      </div>
    </div>
  );
}

/** Imperative confirmation dialog: `if (await confirm({...})) …` */
export function confirm(opts: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; typeToConfirm?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      resolve(v);
      root.unmount();
      host.remove();
    };
    root.render(<ConfirmDialog {...opts} onDone={done} />);
  });
}

function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  typeToConfirm,
  onDone,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
  onDone: (v: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const ok = !typeToConfirm || typed.trim().toUpperCase() === typeToConfirm.toUpperCase();
  return (
    <Sheet open onClose={() => onDone(false)} title={title}>
      <div className="stack-16">
        {body && <div className="muted">{body}</div>}
        {typeToConfirm && (
          <TextField label={`Type ${typeToConfirm} to confirm`} value={typed} onChange={setTyped} autoFocus mono />
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!ok} onClick={() => onDone(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
