import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './button';
import { Icon } from './icons';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A window over the page that asks for a decision. Focus moves into it and stays inside it, Escape
 * closes it, and focus returns to what opened it. (A custom dialog rather than the browser's own, which
 * not every browser handles the same way.)
 */
export function ModalDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  const dialogReference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogReference.current;
    dialog?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();

    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keepFocusInside);
    return () => {
      document.removeEventListener('keydown', keepFocusInside);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-ink/50" aria-hidden="true" onClick={onClose} />
      <div ref={dialogReference} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex w-full max-w-md flex-col gap-4 rounded-lg bg-surface p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-heading">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 -mt-2 flex size-11 items-center justify-center rounded-md hover:bg-ground">
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Asks "are you sure?" before something that can't easily be undone. The action is named on the button, never just "OK". */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  isBusy = false,
  onConfirm,
  onClose,
  tone = 'danger',
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  isBusy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  tone?: 'danger' | 'primary';
}) {
  return (
    <ModalDialog title={title} onClose={onClose}>
      <div className="text-body text-muted">{children}</div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button variant={tone} isBusy={isBusy} busyLabel="Working…" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </ModalDialog>
  );
}
