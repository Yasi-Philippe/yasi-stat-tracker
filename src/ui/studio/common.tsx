import { ArrowLeft, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { navigate, type StudioSection } from '@/app/router';

export function StudioPage({
  title,
  eyebrow = 'Studio',
  back = { section: undefined },
  actions,
  children,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  back?: { section?: StudioSection };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="studio-page">
      <div className="chart-top">
        <button className="icon-btn" onClick={() => navigate({ name: 'studio', section: back.section })} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <div className="row">{actions}</div>
      </div>
      <header className="studio-head">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="display page-title">{title}</h1>
      </header>
      {children}
    </div>
  );
}

export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn primary sm" onClick={onClick}>
      <Plus size={16} /> {label}
    </button>
  );
}

export function Section({ title, children, hint }: { title: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="studio-section">
      <div className="studio-section-head">
        <h2 className="eyebrow">{title}</h2>
        {hint && <span className="tiny faint">{hint}</span>}
      </div>
      <div className="card pad stack-16">{children}</div>
    </section>
  );
}

export function SaveBar({ onSave, onDelete, saveLabel = 'Save', disabled, dirty }: { onSave: () => void; onDelete?: () => void; saveLabel?: string; disabled?: boolean; dirty?: boolean }) {
  return (
    <div className={`save-bar${dirty ? ' dirty' : ''}`}>
      {onDelete ? (
        <button className="btn danger" onClick={onDelete}>
          Delete
        </button>
      ) : (
        <span />
      )}
      <button className="btn primary" onClick={onSave} disabled={disabled}>
        {saveLabel}
      </button>
    </div>
  );
}
