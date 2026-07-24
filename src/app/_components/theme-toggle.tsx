"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "sseclone-theme";

type Theme = "dark" | "light";

// The theme lives on <html> (set pre-hydration by layout.tsx). Read it through
// an external store so there is no setState-in-effect and hydration is clean:
// `getServerSnapshot` returns the default `dark`, matching the server render,
// then React re-reads the real class on the client without a mismatch.
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function getServerSnapshot(): Theme {
  return "dark";
}

function setTheme(next: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private-mode / disabled storage: the class still flips for this session.
  }
  listeners.forEach((l) => l());
}

/** Sun/Moon button toggling <html> between dark and light, persisting the choice. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isDark = theme !== "light";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      {isDark ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
    </button>
  );
}
