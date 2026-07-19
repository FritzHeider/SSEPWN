"use client";

import {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  setTransition,
  TRANSITION_KINDS,
} from "@/lib/timeline/transitions";
import {
  fitTransitionDuration,
  transitionBoundaries,
  type BoundaryPicker,
} from "@/lib/timeline/transitions-view";
import type { TimelineDoc, TransitionKind } from "@/lib/timeline/types";

const sel =
  "rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-950";

/**
 * One boundary picker: the two segments it joins, a kind select (`cut` plus the
 * animated kinds, the latter disabled when neither neighbour is long enough),
 * and a duration slider shown only for an animated blend. Every edit commits
 * through the pure `setTransition` op via `onRun`, with the requested duration
 * clamped by `fitTransitionDuration` so the op never throws.
 */
function BoundaryRow({
  doc,
  boundary,
  onRun,
}: {
  doc: TimelineDoc;
  boundary: BoundaryPicker;
  onRun: (op: () => TimelineDoc) => void;
}) {
  const changeKind = (kind: TransitionKind) => {
    if (kind === "cut") {
      onRun(() => setTransition(doc, boundary.leftId, "cut"));
      return;
    }
    const duration = fitTransitionDuration(
      doc,
      boundary.leftId,
      boundary.duration || DEFAULT_TRANSITION_DURATION,
    );
    onRun(() => setTransition(doc, boundary.leftId, kind, duration));
  };

  const changeDuration = (requested: number) => {
    if (boundary.kind === "cut") return;
    const duration = fitTransitionDuration(doc, boundary.leftId, requested);
    onRun(() => setTransition(doc, boundary.leftId, boundary.kind, duration));
  };

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800"
      data-testid="transition-boundary"
      data-left-id={boundary.leftId}
      data-kind={boundary.kind}
    >
      <span className="font-mono text-zinc-500 dark:text-zinc-400">
        {boundary.leftId} <span aria-hidden>→</span> {boundary.rightId}
      </span>
      <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        transition
        <select
          className={sel}
          value={boundary.kind}
          onChange={(e) => changeKind(e.target.value as TransitionKind)}
          aria-label={`Transition after ${boundary.leftId}`}
        >
          {TRANSITION_KINDS.map((kind) => (
            <option key={kind} value={kind} disabled={kind !== "cut" && !boundary.canAnimate}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      {boundary.kind !== "cut" ? (
        <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
          <input
            type="range"
            min={MIN_TRANSITION_DURATION}
            max={MAX_TRANSITION_DURATION}
            step={0.05}
            value={boundary.duration}
            onChange={(e) => changeDuration(Number(e.target.value))}
            aria-label={`Transition duration after ${boundary.leftId}`}
            className="w-28"
          />
          <span className="w-10 font-mono tabular-nums text-zinc-400">
            {boundary.duration.toFixed(2)}s
          </span>
        </label>
      ) : (
        <span className="text-zinc-400 dark:text-zinc-600">instant</span>
      )}
    </li>
  );
}

/**
 * Transitions picker (Phase 08): a row per segment boundary in playback order,
 * letting the editor pick `cut`/`crossfade`/`slide-left`/`slide-right` and its
 * 0.2–1.5 s duration for the seam between each pair of adjacent segments. All
 * edits go through the pure `lib/timeline/transitions` ops via `onRun` (the
 * timeline panel's error-catching committer); the picker holds no time
 * arithmetic — {@link transitionBoundaries}/{@link fitTransitionDuration} do it.
 */
export function TransitionsPanel({
  doc,
  onRun,
}: {
  doc: TimelineDoc;
  onRun: (op: () => TimelineDoc) => void;
}) {
  const boundaries = transitionBoundaries(doc);

  return (
    <section className="flex flex-col gap-2" aria-label="Transitions">
      <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 text-xs">
        Transitions
      </span>
      {boundaries.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {boundaries.map((boundary) => (
            <BoundaryRow key={boundary.leftId} doc={doc} boundary={boundary} onRun={onRun} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Split the clip to add transitions between segments.
        </p>
      )}
    </section>
  );
}
