"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Explicit id; if a toast with this id already exists it is replaced. */
  id?: string;
  /** Auto-dismiss delay (ms). Defaults: 4000 (or 6000 for error). Set 0 to persist until dismissed. */
  duration?: number;
  /** Optional action button rendered on the toast (e.g. an Undo button). */
  action?: ToastAction;
}

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  action?: ToastAction;
}

interface ToastContextType {
  /** Show a toast and return its id. */
  show: (message: string, variant?: ToastVariant, options?: ToastOptions) => string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  /** Manually dismiss a toast by id. No-op if already gone. */
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 6000;
const MAX_VISIBLE = 4;

const ToastContext = createContext<ToastContextType>({
  show: () => "",
  success: () => "",
  error: () => "",
  warning: () => "",
  info: () => "",
  dismiss: () => {},
});

function defaultDuration(variant: ToastVariant): number {
  return variant === "error" ? ERROR_DURATION : DEFAULT_DURATION;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track per-toast timers so manual dismiss / replacement can clear them.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const idCounterRef = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const timers = timersRef.current;
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer]
  );

  const show = useCallback(
    (message: string, variant: ToastVariant = "info", options?: ToastOptions) => {
      const id = options?.id ?? `toast-${++idCounterRef.current}`;
      const duration = options?.duration ?? defaultDuration(variant);
      const next: Toast = { id, message, variant, duration, action: options?.action };

      clearTimer(id);

      setToasts((prev) => {
        // Replace an existing toast with the same id, otherwise append and
        // trim to MAX_VISIBLE (oldest first).
        const without = prev.filter((t) => t.id !== id);
        const withNext = [...without, next];
        if (withNext.length <= MAX_VISIBLE) return withNext;
        // Drop the oldest entries and clear their timers.
        const overflow = withNext.slice(0, withNext.length - MAX_VISIBLE);
        overflow.forEach((t) => clearTimer(t.id));
        return withNext.slice(withNext.length - MAX_VISIBLE);
      });

      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [clearTimer, dismiss]
  );

  const success = useCallback(
    (message: string, options?: ToastOptions) => show(message, "success", options),
    [show]
  );
  const error = useCallback(
    (message: string, options?: ToastOptions) => show(message, "error", options),
    [show]
  );
  const warning = useCallback(
    (message: string, options?: ToastOptions) => show(message, "warning", options),
    [show]
  );
  const info = useCallback(
    (message: string, options?: ToastOptions) => show(message, "info", options),
    [show]
  );

  // Clear all timers on unmount to avoid leaks across HMR / route changes.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show, success, error, warning, info, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** Inline action click: dismiss first, then run the handler. */
function runAction(action: ToastAction, dismiss: (id: string) => void, id: string) {
  dismiss(id);
  action.onClick();
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  // Defer portal mounting to the client to avoid SSR/hydration mismatches,
  // mirroring the pattern used by FileTransferDialog / SSHPanel / TabBar.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);

  if (!portalReady || typeof document === "undefined") return null;

  const content = (
    <div className="toast-viewport" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.variant}`} role="status">
          <span className="toast-indicator" aria-hidden="true" />
          <span className="toast-message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => runAction(t.action!, onDismiss, t.id)}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="14"
              height="14"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );

  // Render into document.body so toasts float above all app chrome (incl.
  // modals at z-index 1200-1300); the viewport itself sits at z-index 2100.
  return createPortal(content, document.body);
}

export function useToast(): ToastContextType {
  return useContext(ToastContext);
}
