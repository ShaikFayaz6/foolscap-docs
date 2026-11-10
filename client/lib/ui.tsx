import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from '../components/Icon.tsx';

/** Closes a popover when the person clicks outside it or presses Escape. */
export function usePopover(): { open: boolean; setOpen: (open: boolean) => void; ref: RefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus();
    };
    window.document.addEventListener('pointerdown', onPointer);
    window.document.addEventListener('keydown', onKey);
    return () => {
      window.document.removeEventListener('pointerdown', onPointer);
      window.document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Sets the browser tab title while a page is shown. `undefined` leaves it to a child component. */
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    if (title !== undefined) window.document.title = `${title} · Foolscap`;
  }, [title]);
  useEffect(
    () => () => {
      window.document.title = 'Foolscap';
    },
    [],
  );
}

type Toast = { id: number; text: string };
const ToastContext = createContext<(text: string) => void>(() => {});

/** Short confirmations that appear in a corner and fade away on their own. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const show = useCallback((text: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { id, text }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <span className="toast-mark">
              <Icon name="check" size={14} />
            </span>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Two letters for an avatar: first and last initials. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}
