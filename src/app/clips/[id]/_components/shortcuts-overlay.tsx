"use client";

import { Keyboard, X } from "lucide-react";
import { useEffect, useRef } from "react";

/** The shortcut bindings shown in the overlay, grouped for readability. */
const SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: "Space", label: "Play / pause" },
  { keys: "← / →", label: "Seek ∓1 s" },
  { keys: "Shift + ← / →", label: "Seek ∓5 s" },
  { keys: "Alt + ← / →", label: "Nudge ∓0.1 s" },
  { keys: "I / O", label: "Set trim in/out (Timeline) or jump to clip in/out" },
  { keys: "S", label: "Split at playhead (Timeline)" },
  { keys: "Delete", label: "Remove selected segment (Timeline)" },
  { keys: "⌘ / Ctrl + Z", label: "Undo" },
  { keys: "⌘ / Ctrl + Shift + Z", label: "Redo" },
  { keys: "?", label: "Toggle this help" },
  { keys: "Esc", label: "Close this help" },
];

/**
 * The keyboard-shortcuts modal (item 11): a focus-trapped dialog listing every
 * binding, dismissed with Esc (handled by the shell keymap) or its close button.
 * Rendered only when open; the shell owns the open state and the `?`/Esc keys.
 */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog when it opens so Esc/close are reachable.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-testid="shortcuts-overlay"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border-subtle bg-surface-overlay p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="shortcuts-title" className="flex items-center gap-2 text-base font-semibold text-text">
            <Keyboard className="h-5 w-5 text-accent" aria-hidden />
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded p-1 text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <dl className="flex flex-col gap-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-text-muted">{s.label}</dt>
              <dd>
                <kbd className="rounded border border-border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-text">
                  {s.keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
