import { Check, Copy, PencilLine } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { allThemes, useSettings, useTheme, useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { deleteTheme, newId, saveSettings, saveTheme } from '@/core/data/repo';
import type { ChartSpec, ThemeDef, ThemeTokens } from '@/core/model/types';
import type { TimeChartData } from '@/core/engine/types';
import { buildOption } from '../charts/buildOption';
import { ChartCanvas } from '../charts/ChartCanvas';
import { confirm, Segmented, Select, TextField } from '../components/Controls';
import { Sparkline } from '../components/Sparkline';
import { toast } from '../components/Toast';
import { applyTheme, themeVars } from '../theme/applyTheme';
import { FONT_CHOICES, fontStack } from '../theme/themes';
import { SaveBar, Section, StudioPage } from './common';

export function ThemesSection({ id }: { id?: string }) {
  if (id) return <ThemeEditor id={id} />;
  return <ThemeGallery />;
}

const SAMPLE: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [i, 50 + Math.sin(i / 4) * 8 + i * 0.6 + Math.cos(i * 1.7) * 2]);

function ThemeGallery() {
  const { vault, version } = useVault();
  const settings = useSettings();
  const list = useMemo(() => allThemes(vault), [vault, version]);
  const duplicate = (t: ThemeDef) => {
    const copy: ThemeDef = { id: newId(), name: `${t.name} (mine)`, tokens: { ...t.tokens, palette: [...t.tokens.palette] } };
    saveTheme(vault, copy);
    navigate({ name: 'studio', section: 'themes', id: copy.id });
  };
  return (
    <StudioPage title={<em>Themes</em>}>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 16 }}>
        Tap a theme to use it. Duplicate one to make it yours: every colour, font, corner, glow and chart line is editable.
      </p>
      <div className="theme-grid">
        {list.map((t) => {
          const active = t.id === settings.themeId;
          return (
            <div key={t.id} className={`theme-card${active ? ' active' : ''}`} style={themeVars(t.tokens) as React.CSSProperties}>
              <button className="theme-preview" onClick={() => saveSettings(vault, { themeId: t.id })} aria-pressed={active}>
                <div className="theme-top">
                  <span className="theme-name" style={{ fontFamily: fontStack(t.tokens.fontDisplay) }}>
                    {t.name}
                  </span>
                  {active && (
                    <span className="theme-check">
                      <Check size={14} />
                    </span>
                  )}
                </div>
                <div className="theme-number" style={{ fontFamily: fontStack(t.tokens.fontDisplay) }}>
                  72<span style={{ opacity: 0.55 }}>.4</span>
                </div>
                <div className="theme-spark">
                  <Sparkline points={SAMPLE} height={40} width={200} color={t.tokens.accent} />
                </div>
                <div className="theme-swatches">
                  {[t.tokens.accent, t.tokens.accent2, ...t.tokens.palette.slice(2, 6)].map((c, i) => (
                    <span key={i} style={{ background: c }} />
                  ))}
                </div>
              </button>
              <div className="theme-actions">
                {!t.builtIn && (
                  <button className="btn sm ghost" onClick={() => navigate({ name: 'studio', section: 'themes', id: t.id })}>
                    <PencilLine size={14} /> Edit
                  </button>
                )}
                <button className="btn sm ghost" onClick={() => duplicate(t)}>
                  <Copy size={14} /> Duplicate
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </StudioPage>
  );
}

const COLOR_FIELDS: Array<[keyof ThemeTokens, string]> = [
  ['bg', 'Background'],
  ['surface', 'Cards'],
  ['surface2', 'Inputs'],
  ['text', 'Text'],
  ['muted', 'Secondary text'],
  ['accent', 'Accent'],
  ['accent2', 'Second accent'],
  ['positive', 'Good'],
  ['negative', 'Bad'],
];

function ThemeEditor({ id }: { id: string }) {
  const { vault } = useVault();
  const current = useTheme();
  const original = useMemo(() => allThemes(vault).find((t) => t.id === id), [vault, id]);
  const [t, setT] = useState<ThemeDef | undefined>(original);

  // Live preview: paint the whole app with the draft while editing.
  useEffect(() => {
    if (t) applyTheme(t.tokens);
  }, [t]);
  useEffect(() => () => applyTheme(current.tokens), [current]);

  if (!t || !original) {
    return (
      <StudioPage title="Not found" back={{ section: 'themes' }}>
        <p className="muted">This theme no longer exists.</p>
      </StudioPage>
    );
  }
  if (original.builtIn) {
    return (
      <StudioPage title={<em>{original.name}</em>} back={{ section: 'themes' }}>
        <p className="muted">Built-in themes can't be edited — duplicate it from the gallery.</p>
      </StudioPage>
    );
  }
  const tok = t.tokens;
  const setTok = (patch: Partial<ThemeTokens>) => setT({ ...t, tokens: { ...tok, ...patch } });

  return (
    <StudioPage title={<em>{t.name || 'Theme'}</em>} back={{ section: 'themes' }} eyebrow="Theme">
      <div className="editor-layout">
        <div className="editor-preview">
          <ThemePreview tokens={tok} />
        </div>
        <div className="studio-form">
          <Section title="Name">
            <TextField label="Name" value={t.name} onChange={(name) => setT({ ...t, name })} />
            <Segmented
              value={tok.scheme}
              onChange={(scheme) => setTok({ scheme })}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
            />
          </Section>
          <Section title="Colours">
            <div className="color-fields">
              {COLOR_FIELDS.map(([key, label]) => (
                <label key={key} className="color-field">
                  <input type="color" value={toHex(tok[key] as string)} onChange={(e) => setTok({ [key]: e.target.value } as Partial<ThemeTokens>)} />
                  <span className="small">{label}</span>
                </label>
              ))}
            </div>
            <div className="field">
              <span className="field-label">Chart series colours</span>
              <div className="row wrap">
                {tok.palette.map((c, i) => (
                  <input
                    key={i}
                    type="color"
                    className="palette-input"
                    value={toHex(c)}
                    onChange={(e) => setTok({ palette: tok.palette.map((x, j) => (j === i ? e.target.value : x)) })}
                    aria-label={`Series colour ${i + 1}`}
                  />
                ))}
              </div>
            </div>
          </Section>
          <Section title="Type">
            <Select label="Interface" value={tok.fontUI} onChange={(fontUI) => setTok({ fontUI })} options={FONT_CHOICES.map((f) => ({ value: f.id, label: f.label }))} />
            <Select label="Big numbers and titles" value={tok.fontDisplay} onChange={(fontDisplay) => setTok({ fontDisplay })} options={FONT_CHOICES.map((f) => ({ value: f.id, label: f.label }))} />
            <Select label="Chart labels and figures" value={tok.fontNumber} onChange={(fontNumber) => setTok({ fontNumber })} options={FONT_CHOICES.map((f) => ({ value: f.id, label: f.label }))} />
          </Section>
          <Section title="Shape and light">
            <Slider label="Corner roundness" value={tok.radius} min={0} max={28} step={1} onChange={(radius) => setTok({ radius })} format={(v) => `${v}px`} />
            <Slider label="Glow" value={tok.glow} min={0} max={1} step={0.05} onChange={(glow) => setTok({ glow })} format={(v) => `${Math.round(v * 100)}%`} />
          </Section>
          <Section title="Charts">
            <div className="field">
              <span className="field-label">Lines</span>
              <Segmented
                value={tok.curve}
                onChange={(curve) => setTok({ curve })}
                options={[
                  { value: 'straight', label: 'Straight' },
                  { value: 'smooth', label: 'Smooth' },
                  { value: 'step', label: 'Steps' },
                ]}
              />
            </div>
            <div className="field">
              <span className="field-label">Grid</span>
              <Segmented
                value={tok.grid}
                onChange={(grid) => setTok({ grid })}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'faint', label: 'Faint' },
                  { value: 'dashed', label: 'Dashed' },
                ]}
              />
            </div>
            <Slider label="Line width" value={tok.lineWidth} min={1} max={4} step={0.1} onChange={(lineWidth) => setTok({ lineWidth })} format={(v) => v.toFixed(1)} />
            <Slider label="Area fill" value={tok.areaOpacity} min={0} max={0.6} step={0.02} onChange={(areaOpacity) => setTok({ areaOpacity })} format={(v) => `${Math.round(v * 100)}%`} />
          </Section>
        </div>
      </div>
      <SaveBar
        saveLabel="Save and use"
        disabled={!t.name.trim()}
        onSave={() => {
          vault.batch(() => {
            saveTheme(vault, { ...t, name: t.name.trim() });
            saveSettings(vault, { themeId: t.id });
          });
          toast('Theme saved');
          navigate({ name: 'studio', section: 'themes' }, { replace: true });
        }}
        onDelete={async () => {
          if (await confirm({ title: `Delete ${t.name}?`, confirmLabel: 'Delete', danger: true })) {
            vault.batch(() => {
              deleteTheme(vault, t.id);
              saveSettings(vault, { themeId: 'nocturne' });
            });
            navigate({ name: 'studio', section: 'themes' }, { replace: true });
          }
        }}
      />
    </StudioPage>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <label className="field">
      <span className="spread">
        <span className="field-label">{label}</span>
        <span className="small num">{format(value)}</span>
      </span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).replace(/./g, (x) => x + x)}`;
  return '#888888';
}

const PREVIEW_SPEC: ChartSpec = {
  id: 'preview',
  title: 'Preview',
  kind: 'area',
  x: { mode: 'date' },
  series: [
    { id: 'a', expr: 'a', label: 'Weight' },
    { id: 'b', expr: 'b', label: 'Trend', style: { smooth: true } },
  ],
  view: { preset: 'all' },
  unit: 'kg',
  decimals: 1,
};

function ThemePreview({ tokens }: { tokens: ThemeTokens }) {
  const data = useMemo<TimeChartData>(() => {
    const start = 20000;
    const a: Array<[number, number]> = [];
    const b: Array<[number, number]> = [];
    let v = 78;
    let tr = 78;
    for (let i = 0; i < 90; i++) {
      v += Math.sin(i / 6) * 0.25 - 0.05 + Math.cos(i * 2.3) * 0.3;
      tr = tr * 0.85 + v * 0.15;
      if (i % 5 !== 3) a.push([start + i, v]);
      b.push([start + i, tr]);
    }
    return {
      mode: 'time',
      series: [
        { id: 'a', label: 'Weight', points: a, step: false },
        { id: 'b', label: 'Trend', points: b, step: false },
      ],
      bands: [{ start: start + 30, end: start + 60, label: 'Campaign', periodId: 'x' }],
      domain: { min: start, max: start + 89 },
      errors: [],
    };
  }, []);
  const option = useMemo(() => buildOption(data, { spec: PREVIEW_SPEC, theme: tokens, size: 'card' }), [data, tokens]);
  return (
    <div className="card chart-stage theme-live">
      <div className="eyebrow">Live preview</div>
      <div className="display" style={{ fontSize: 46, fontStyle: 'italic', margin: '4px 0 2px' }}>
        74<span style={{ opacity: 0.55 }}>.2</span> <span className="small muted">kg</span>
      </div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="chip pos">−1.4 kg</span>
        <span className="chip accent">Campaign · day 23</span>
      </div>
      <ChartCanvas option={option} height={200} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary sm">Log</button>
        <button className="btn sm">Secondary</button>
      </div>
    </div>
  );
}
