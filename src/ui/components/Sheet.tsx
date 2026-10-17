import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBackHandler } from '@/app/hooks';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** Extra controls in the header, left of the close button. */
  actions?: ReactNode;
  dismissable?: boolean;
}

export function Sheet({ open, onClose, title, children, wide, actions, dismissable = true }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    if (dismissable) onClose();
  }, [dismissable, onClose]);
  // Callers often pass a fresh onClose each render; read it through a ref so
  // the focus handling below runs only when the sheet opens or closes.
  const closeRef = useRef(close);
  closeRef.current = close;
  const stableClose = useCallback(() => closeRef.current(), []);
  useBackHandler(open, stableClose);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    // Respect autoFocus inside the sheet; otherwise focus the sheet itself.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="grabber" />
        {(title || dismissable) && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <div className="row">
              {actions}
              {dismissable && (
                <button className="icon-btn" onClick={close} aria-label="Close">
                  <X size={20} />
                </button>
              )}
            </div>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
