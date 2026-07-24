"use client";

import { Scissors, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  NO_SELECTION,
  highlightParts,
  isSelected,
  matchingSegmentIndices,
  searchCountLabel,
  selectionBounds,
  selectionTimeRange,
} from "@/lib/projects/transcript-search";
import { formatTimestamp } from "@/lib/transcribe/panel";
import type { TranscriptSegment } from "@/lib/transcribe/types";

/** How long a reason-chip flash-highlight lingers before fading. */
const FLASH_MS = 1400;

/**
 * The transcript rail (items 17, 18): a search box that filters + highlights
 * segments, a "Select range" mode that turns two clicks into a manual clip, and
 * click-to-seek on every segment. Auto-scrolls the active segment into view as
 * playback advances, and flash-highlights a segment when a clip's reason chip
 * links to it.
 *
 * All the string/index math (match, highlight, order-agnostic range) is in
 * `lib/projects/transcript-search.ts`; this component wires it to the DOM.
 */
export function TranscriptRail({
  segments,
  activeIndex,
  emptyMessage,
  skeleton,
  flashIndex,
  flashNonce,
  onSeek,
  onCreateClip,
}: {
  segments: TranscriptSegment[];
  activeIndex: number;
  /** Non-null when there is nothing to render (transcribing, no audio, silence). */
  emptyMessage: string | null;
  /** True while transcribe is in flight and there is nothing yet — show shimmer. */
  skeleton: boolean;
  /** Segment to scroll to and flash (reason-chip link), or NO_SELECTION. */
  flashIndex: number;
  /** Bumps on every reason-chip click so re-clicking the same clip re-flashes. */
  flashNonce: number;
  onSeek: (seconds: number) => void;
  onCreateClip: (start: number, end: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selStart, setSelStart] = useState(NO_SELECTION);
  const [selEnd, setSelEnd] = useState(NO_SELECTION);
  const [flashing, setFlashing] = useState(NO_SELECTION);
  const [prevNonce, setPrevNonce] = useState(flashNonce);

  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  // A reason chip bumps `flashNonce`; arm the flash by adjusting state during
  // render (React's "react to a prop change" pattern), then the effect below
  // scrolls to it and schedules the clear.
  if (flashNonce !== prevNonce) {
    setPrevNonce(flashNonce);
    if (flashIndex >= 0) setFlashing(flashIndex);
  }

  const visible = matchingSegmentIndices(segments, query);
  const bounds = selectionBounds(selStart, selEnd);
  const range = selectionTimeRange(segments, selStart, selEnd);

  // Auto-scroll the active segment into view as playback advances — only at xl+,
  // where the rail is its own scroll column; below that the transcript is stacked
  // under the video and scrolling it would yank the whole page during playback.
  // `block: "nearest"` scrolls instantly (reduced-motion-safe) and no-ops when
  // already visible.
  useEffect(() => {
    if (activeIndex < 0) return;
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1280px)").matches) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Once a flash is armed, scroll to the segment and clear it after a beat. The
  // clear runs in the timeout callback (not synchronously in the effect body).
  useEffect(() => {
    if (flashing < 0) return;
    itemRefs.current[flashing]?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => setFlashing(NO_SELECTION), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashing]);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelStart(NO_SELECTION);
    setSelEnd(NO_SELECTION);
  }, []);

  // Esc cancels selection mode.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitSelect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelect]);

  const clickSegment = useCallback(
    (index: number, start: number) => {
      if (!selectMode) {
        onSeek(start);
        return;
      }
      // First click sets the start; second sets the end; a third restarts.
      if (selStart === NO_SELECTION || selEnd !== NO_SELECTION) {
        setSelStart(index);
        setSelEnd(NO_SELECTION);
      } else {
        setSelEnd(index);
      }
    },
    [selectMode, selStart, selEnd, onSeek],
  );

  const createClip = useCallback(() => {
    if (!range) return;
    onCreateClip(range.start, range.end);
    exitSelect();
  }, [range, onCreateClip, exitSelect]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Transcript</h2>
        {segments.length > 0 ? (
          <button
            type="button"
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            aria-pressed={selectMode}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              selectMode
                ? "border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--text)]"
                : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            <Scissors className="h-3.5 w-3.5" aria-hidden />
            {selectMode ? "Selecting…" : "Select range"}
          </button>
        ) : null}
      </div>

      {segments.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <input
              data-testid="transcript-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search transcript"
              aria-label="Search transcript"
              className="h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] pl-8 pr-3 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          </div>
          <p className="text-xs text-[var(--text-muted)]">{searchCountLabel(visible.length, segments.length, query)}</p>
        </div>
      ) : null}

      {emptyMessage ? (
        skeleton ? (
          <TranscriptSkeleton />
        ) : (
          <p className="rounded-lg border border-[var(--border-subtle)] p-6 text-sm text-[var(--text-muted)]">
            {emptyMessage}
          </p>
        )
      ) : (
        <ol className="flex flex-col gap-1">
          {visible.map((index) => {
            const segment = segments[index];
            const active = index === activeIndex;
            const selected = isSelected(index, selStart, selEnd);
            const flash = index === flashing;
            return (
              <li key={`${segment.start}-${index}`} ref={(el) => { itemRefs.current[index] = el; }}>
                <button
                  type="button"
                  onClick={() => clickSegment(index, segment.start)}
                  aria-current={active ? "true" : undefined}
                  className={`flex w-full gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--text)]"
                      : active
                        ? "bg-[color-mix(in_oklab,var(--timeline)_16%,transparent)] text-[var(--text)]"
                        : "text-[var(--text)] hover:bg-[var(--surface-overlay)]"
                  } ${flash ? "ring-2 ring-[var(--accent)]" : ""}`}
                >
                  <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-[var(--text-muted)]">
                    {formatTimestamp(segment.start)}
                  </span>
                  <span>
                    {highlightParts(segment.text, query).map((part, p) =>
                      part.match ? (
                        <mark key={p} className="rounded bg-[color-mix(in_oklab,var(--accent)_35%,transparent)] text-[var(--text)]">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={p}>{part.text}</span>
                      ),
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {selectMode && bounds && range ? (
        <div className="sticky bottom-3 flex justify-center">
          <button
            type="button"
            onClick={createClip}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] shadow-lg transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Scissors className="h-4 w-4" aria-hidden />
            Create clip {formatTimestamp(range.start)} – {formatTimestamp(range.end)}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TranscriptSkeleton() {
  return (
    <ol className="flex flex-col gap-1" aria-hidden data-testid="transcript-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex gap-3 px-3 py-2">
          <span className="h-4 w-8 shrink-0 animate-pulse rounded bg-[var(--surface-overlay)]" />
          <span className="h-4 flex-1 animate-pulse rounded bg-[var(--surface-overlay)]" style={{ width: `${70 + ((i * 7) % 25)}%` }} />
        </li>
      ))}
    </ol>
  );
}
