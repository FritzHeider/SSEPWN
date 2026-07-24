"use client";

import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "./theme-toggle";
import { useWorkerHealth, WorkerOfflineBanner, WorkerStatus } from "./worker-status";

const NAV = [
  { href: "/", label: "Projects" },
  { href: "/templates", label: "Templates" },
] as const;

/**
 * Slim sticky top bar rendered on every page from layout.tsx. Client component
 * so it can highlight the active route (usePathname) and poll worker health.
 */
export function AppShell() {
  const pathname = usePathname();
  const health = useWorkerHealth();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)]">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Clapperboard className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            <span className="font-mono text-base font-semibold tracking-tight text-[var(--text)]">
              Sseclone
            </span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    active
                      ? "bg-[var(--surface-overlay)] text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <WorkerStatus health={health} />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <WorkerOfflineBanner health={health} />
    </>
  );
}
