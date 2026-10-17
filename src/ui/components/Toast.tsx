import { AlertCircle, Check } from 'lucide-react';
import { useSyncExternalStore } from 'react';

interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, opts: { kind?: 'info' | 'error'; action?: ToastItem['action']; ms?: number } = {}): void {
  const item: ToastItem = { id: nextId++, text, kind: opts.kind ?? 'info', action: opts.action };
  items = [...items.slice(-2), item];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    emit();
  }, opts.ms ?? (opts.action ? 5000 : 2600));
}

export function toastError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), { kind: 'error', ms: 4500 });
}

export function Toasts() {
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => items,
  );
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          {t.kind === 'error' ? <AlertCircle size={18} /> : <Check size={18} />}
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                items = items.filter((i) => i.id !== t.id);
                emit();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
