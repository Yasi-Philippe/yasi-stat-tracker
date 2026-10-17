import { Plus } from 'lucide-react';
import { useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { applyTemplate, TEMPLATES } from '@/core/data/templates';
import { confirm } from '../components/Controls';
import { MetricIcon } from '../components/Icon';
import { toast } from '../components/Toast';
import { StudioPage } from './common';

export function TemplatesSection() {
  const { vault } = useVault();
  return (
    <StudioPage title={<em>Starter packs</em>}>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 16 }}>
        Each pack adds metrics, formulas, periods, charts and a dashboard. Names that already exist get a number, so nothing is overwritten.
      </p>
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <div key={t.id} className="template card">
            <span className="template-icon">
              <MetricIcon name={t.icon} size={22} />
            </span>
            <span className="template-name">{t.name}</span>
            <span className="small muted grow">{t.description}</span>
            <button
              className="btn sm"
              style={{ marginTop: 10 }}
              onClick={async () => {
                if (!(await confirm({ title: `Add the ${t.name} pack?`, body: t.description, confirmLabel: 'Add pack' }))) return;
                applyTemplate(vault, t.id);
                toast(`${t.name} added`);
                navigate({ name: 'charts' });
              }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
        ))}
      </div>
    </StudioPage>
  );
}
