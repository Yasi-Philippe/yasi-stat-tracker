import { BookOpen, Sigma } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@/app/hooks';
import { ExprError, FUNCTION_DOCS } from '@/core/engine';
import type { Value } from '@/core/engine/types';
import { Sheet } from '../components/Sheet';
import { Sparkline } from '../components/Sparkline';
import { fmtNum } from '../format';

const QUICK_FUNCTIONS = ['ma', 'pct', 'fill', 'since', 'first', 'last', 'median', 'monthly', 'rolling', 'cumsum', 'between', 'delta'];

/**
 * Formula input with live checking, name suggestions and a preview of the
 * result. `exclude` hides a slug from suggestions (a formula cannot use itself).
 */
export function ExprInput({
  value,
  onChange,
  exclude,
  preview = true,
  decimals = 2,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  exclude?: string;
  preview?: boolean;
  decimals?: number;
  autoFocus?: boolean;
}) {
  const { ws } = useWorkspace();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [docs, setDocs] = useState(false);
  const idents = useMemo(() => ws.identifiers().filter((i) => i.slug !== exclude), [ws, exclude]);

  const check = useMemo(() => {
    if (!value.trim()) return { ok: false as const, error: null };
    const v = ws.validate(value);
    if (!v.ok) return { ok: false as const, error: v.error };
    if (exclude && v.deps.includes(exclude)) return { ok: false as const, error: new ExprError('A formula cannot use itself.') };
    try {
      return { ok: true as const, value: ws.evalExpr(value) };
    } catch (err) {
      return { ok: false as const, error: err instanceof ExprError ? err : new ExprError(String(err)) };
    }
  }, [value, ws, exclude]);

  const insert = (text: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const pad = before && !/[\s(,]$/.test(before) ? ' ' : '';
    const next = before + pad + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = (before + pad + text).length - (text.endsWith('()') ? 1 : 0);
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const span = !check.ok && check.error?.span ? check.error.span : null;

  return (
    <div className="expr">
      <div className={`expr-box${check.error ? ' invalid' : check.ok ? ' valid' : ''}`}>
        <textarea
          ref={ref}
          className="expr-input"
          value={value}
          rows={2}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus={autoFocus}
          placeholder="e.g. weight / (height / 100) ^ 2"
          onChange={(e) => onChange(e.target.value)}
        />
        {span && (
          <div className="expr-underline" aria-hidden>
            <span>{value.slice(0, span.start)}</span>
            <mark>{value.slice(span.start, Math.max(span.end, span.start + 1)) || ' '}</mark>
          </div>
        )}
      </div>
      {check.error ? (
        <div className="expr-msg error">
          {check.error.message}
          {check.error.hint && (
            <button className="link-btn" onClick={() => span && onChange(value.slice(0, span.start) + check.error!.hint + value.slice(span.end))}>
              {' '}
              Use “{check.error.hint}”
            </button>
          )}
        </div>
      ) : check.ok && preview ? (
        <ValuePreview value={check.value} decimals={decimals} />
      ) : null}

      <div className="expr-suggest scroll-x">
        {idents.map((i) => (
          <button key={i.slug} type="button" className="chip" onClick={() => insert(i.slug)} title={`${i.name} (${i.unit})`}>
            {i.slug}
          </button>
        ))}
        <span className="expr-sep" />
        {QUICK_FUNCTIONS.map((f) => (
          <button key={f} type="button" className="chip accent" onClick={() => insert(`${f}()`)}>
            <Sigma size={12} /> {f}
          </button>
        ))}
        <button type="button" className="chip" onClick={() => setDocs(true)}>
          <BookOpen size={12} /> All functions
        </button>
      </div>

      <Sheet open={docs} onClose={() => setDocs(false)} title="Functions" wide>
        <div className="fn-docs">
          {(['aggregate', 'transform', 'time', 'math', 'logic'] as const).map((cat) => {
            const list = FUNCTION_DOCS.filter((d) => d.category === cat);
            if (!list.length) return null;
            return (
              <section key={cat}>
                <h3 className="eyebrow">{cat}</h3>
                {list.map((d) => (
                  <button
                    key={d.name}
                    className="fn-doc"
                    onClick={() => {
                      insert(`${d.name}()`);
                      setDocs(false);
                    }}
                  >
                    <code className="num">{d.signature}</code>
                    <span className="small muted">{d.description}</span>
                    <code className="tiny faint">{d.example}</code>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}

function ValuePreview({ value, decimals }: { value: Value; decimals: number }) {
  if (value.kind === 'scalar') {
    return (
      <div className="expr-msg ok">
        = <b className="num">{fmtNum(value.value, decimals)}</b>
      </div>
    );
  }
  if (value.kind === 'fn') {
    return <div className="expr-msg ok">A value for every day (e.g. days since a date).</div>;
  }
  const n = value.t.length;
  if (!n) return <div className="expr-msg">Valid, but there is no data yet.</div>;
  const from = Math.max(0, n - 120);
  const pts: Array<[number, number]> = [];
  for (let i = from; i < n; i++) pts.push([value.t[i]!, value.v[i]!]);
  return (
    <div className="expr-msg ok expr-preview">
      <span>
        Latest <b className="num">{fmtNum(value.v[n - 1]!, decimals)}</b> · {n} points
        {value.step ? ' · holds between entries' : ''}
      </span>
      <div className="expr-spark">
        <Sparkline points={pts} height={34} width={160} />
      </div>
    </div>
  );
}
