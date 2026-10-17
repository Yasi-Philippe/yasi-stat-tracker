import { ChevronRight, Sigma } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { renameSlugEverywhere, slugProblem, slugUsages } from '@/core/data/refs';
import { deleteFormula, formulas, newId, nextOrder, saveFormula, slugify, usedSlugs } from '@/core/data/repo';
import type { FormulaDef } from '@/core/model/types';
import { ColorPicker, confirm, Segmented, TextField } from '../components/Controls';
import { toast } from '../components/Toast';
import { AddButton, SaveBar, Section, StudioPage } from './common';
import { ExprInput } from './ExprInput';

export function FormulasSection({ id }: { id?: string }) {
  if (id) return <FormulaEditor id={id} />;
  return <FormulaList />;
}

function FormulaList() {
  const { vault, version } = useVault();
  const list = useMemo(() => formulas(vault), [vault, version]);
  return (
    <StudioPage title={<em>Formulas</em>} actions={<AddButton label="New formula" onClick={() => navigate({ name: 'studio', section: 'formulas', id: 'new' })} />}>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 16 }}>
        A formula is a value computed from your metrics — BMI from weight and height, net worth from accounts. It updates by itself and can be charted like
        any metric.
      </p>
      {list.length === 0 ? (
        <div className="empty card">
          <Sigma size={26} />
          <h3>No formulas yet</h3>
        </div>
      ) : (
        <div className="card list">
          {list.map((f) => (
            <button key={f.id} className="list-row" onClick={() => navigate({ name: 'studio', section: 'formulas', id: f.id })}>
              <span className="badge" style={{ color: f.color || 'var(--accent-2)' }}>
                <Sigma size={18} />
              </span>
              <span className="grow">
                <span className="title">{f.name}</span>
                <span className="sub">
                  <code className="num">{f.slug}</code> = <code className="num">{f.expr}</code>
                </span>
              </span>
              <ChevronRight size={16} className="faint" />
            </button>
          ))}
        </div>
      )}
    </StudioPage>
  );
}

function FormulaEditor({ id }: { id: string }) {
  const { vault } = useVault();
  const isNew = id === 'new';
  const original = useMemo(() => (isNew ? undefined : formulas(vault).find((f) => f.id === id)), [vault, id, isNew]);
  const [f, setF] = useState<FormulaDef>(
    () => original ?? { id: newId(), slug: '', name: '', unit: '', expr: '', decimals: 2, order: nextOrder(formulas(vault)) },
  );
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const used = useMemo(() => usedSlugs(vault, original?.id), [vault, original?.id]);
  const set = (patch: Partial<FormulaDef>) => setF((p) => ({ ...p, ...patch }));
  const slug = slugTouched ? f.slug : slugify(f.name || 'formula');
  const slugErr = f.name ? slugProblem(slug, used) : null;

  if (!isNew && !original) {
    return (
      <StudioPage title="Not found" back={{ section: 'formulas' }}>
        <p className="muted">This formula no longer exists.</p>
      </StudioPage>
    );
  }

  const save = async () => {
    if (original && original.slug !== slug) {
      const usages = slugUsages(vault, original.slug);
      if (usages.length && !(await confirm({ title: 'Rename everywhere?', body: `Used by ${usages.length} formula(s)/chart(s); they will follow the new name.`, confirmLabel: 'Rename' }))) return;
      renameSlugEverywhere(vault, original.slug, slug);
    }
    saveFormula(vault, { ...f, slug, name: f.name.trim(), expr: f.expr.trim() });
    toast(isNew ? `${f.name.trim()} created` : 'Saved');
    navigate({ name: 'studio', section: 'formulas' }, { replace: true });
  };

  const remove = async () => {
    if (!original) return;
    const usages = slugUsages(vault, original.slug);
    if (
      !(await confirm({
        title: `Delete ${original.name}?`,
        body: usages.length ? `Still used by: ${usages.map((u) => u.name).join(', ')}. Those will show an error.` : 'Your data is not affected.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    deleteFormula(vault, original.id);
    navigate({ name: 'studio', section: 'formulas' }, { replace: true });
  };

  return (
    <StudioPage title={isNew ? <em>New formula</em> : <em>{original!.name}</em>} back={{ section: 'formulas' }} eyebrow="Formula">
      <div className="studio-form">
        <Section title="Expression">
          <ExprInput value={f.expr} onChange={(expr) => set({ expr })} exclude={original?.slug ?? slug} decimals={f.decimals} autoFocus={isNew} />
          <p className="tiny faint">
            Use the names of your metrics and formulas, + − × ÷ ^ and functions. Examples: <code>weight / (height / 100) ^ 2</code> ·{' '}
            <code>bank + fill(fund_a, 0)</code> · <code>ma(weight, 7)</code>
          </p>
        </Section>
        <Section title="Details">
          <TextField label="Name" value={f.name} onChange={(name) => set({ name })} placeholder="e.g. BMI" />
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <TextField label="Unit" value={f.unit} onChange={(unit) => set({ unit })} placeholder="kg/m², %, €…" />
            </div>
            <div className="grow">
              <TextField
                label="Name in formulas"
                mono
                value={slug}
                onChange={(v) => {
                  setSlugTouched(true);
                  set({ slug: v.toLowerCase().replace(/[^a-z0-9_]/g, '_') });
                }}
                error={slugErr ?? undefined}
              />
            </div>
          </div>
          <div className="field">
            <span className="field-label">Decimals</span>
            <Segmented value={String(f.decimals)} onChange={(d) => set({ decimals: Number(d) })} options={['0', '1', '2', '3'].map((d) => ({ value: d, label: d }))} />
          </div>
          <TextField label="Group" value={f.group ?? ''} onChange={(group) => set({ group })} />
          <div className="field">
            <span className="field-label">Colour</span>
            <ColorPicker value={f.color} onChange={(color) => set({ color })} allowNone />
          </div>
        </Section>
      </div>
      <SaveBar onSave={() => void save()} onDelete={original ? () => void remove() : undefined} disabled={!f.name.trim() || !f.expr.trim() || !!slugErr} saveLabel={isNew ? 'Create formula' : 'Save'} />
    </StudioPage>
  );
}
