import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';

type ToastTone = 'success' | 'neutral';
interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const TOAST_MILLISECONDS = 6_000;
const ShowToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

/** Shows a short confirmation ("Published. On air now.") that goes away by itself and is announced politely. */
export function useToast() {
  return useContext(ShowToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), TOAST_MILLISECONDS));
    },
    [dismiss],
  );

  useEffect(() => {
    const activeTimers = timers.current;
    return () => activeTimers.forEach((timer) => clearTimeout(timer));
  }, []);

  const contextValue = useMemo(() => show, [show]);

  return (
    <ShowToastContext.Provider value={contextValue}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto flex max-w-md items-center gap-3 rounded-md bg-ink px-4 py-3 text-label text-surface shadow-lg">
            {toast.tone === 'success' ? <Icon name="check" size={18} /> : null}
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="-my-1 -mr-2 flex size-11 items-center justify-center rounded-md hover:bg-surface/10"
              aria-label="Dismiss message"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ShowToastContext.Provider>
  );
}
