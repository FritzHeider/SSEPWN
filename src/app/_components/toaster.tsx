"use client";

import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type ToastVariant = "default" | "success" | "danger";

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay; defaults to 4000ms. */
  durationMs?: number;
};

type Toast = ToastOptions & { id: number };

type ToastContextValue = { toast: (options: ToastOptions) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 4000;

/**
 * Dependency-free toast system. Mount `<ToastProvider>` once (layout.tsx wraps
 * children); any client component calls `useToast().toast(...)`. Toasts stack
 * bottom-right in an `aria-live="polite"` region, auto-dismiss after
 * `durationMs`, pause that timer on hover, and support an optional action
 * button (this powers "Undo delete" later).
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    setToasts((current) => [...current, { ...options, id: nextId.current++ }]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-0 right-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return context;
}

const VARIANT_ACCENT: Readonly<Record<ToastVariant, string>> = {
  default: "var(--accent)",
  success: "var(--success)",
  danger: "var(--danger)",
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const duration = toast.durationMs ?? DEFAULT_DURATION_MS;
  const [paused, setPaused] = useState(false);

  // Auto-dismiss, paused on hover. Re-running on `paused` restarts the timer
  // when the pointer leaves — a small overshoot beats tracking remaining time.
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [paused, duration, onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      style={{ borderLeftColor: VARIANT_ACCENT[toast.variant ?? "default"] }}
      className="pointer-events-auto flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] border-l-4 bg-[var(--surface-overlay)] p-3 pr-2 shadow-lg [animation:toast-in_200ms_ease-out]"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium text-[var(--text)]">{toast.title}</p>
        {toast.description ? (
          <p className="text-sm text-[var(--text-muted)]">{toast.description}</p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="mt-1 self-start text-sm font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
