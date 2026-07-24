"use client";

/**
 * Shimmer placeholders shaped like the eventual UI (item 25), shown while a
 * pipeline step is known to be in flight — a clip-card block while generate-clips
 * runs, a poster block while a video's metadata loads. `animate-pulse` is calmed
 * automatically under prefers-reduced-motion by the global rule in globals.css.
 */
export function ClipCardSkeletons({ count = 3 }: { count?: number }) {
  return (
    <ol className="flex flex-col gap-2" aria-hidden data-testid="clips-skeleton">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3">
          <span className="aspect-video h-12 shrink-0 animate-pulse rounded bg-[var(--surface-overlay)]" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <span className="h-4 w-2/5 animate-pulse rounded bg-[var(--surface-overlay)]" />
            <span className="h-3 w-3/5 animate-pulse rounded bg-[var(--surface-overlay)]" />
            <span className="h-3 w-1/4 animate-pulse rounded bg-[var(--surface-overlay)]" />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function PosterSkeleton() {
  return (
    <span
      aria-hidden
      data-testid="poster-skeleton"
      className="absolute inset-0 animate-pulse rounded-lg bg-[var(--surface-overlay)]"
    />
  );
}
