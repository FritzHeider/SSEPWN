# Phase 07: Timeline editor UI

Read `SPEC.md` first. Prerequisite: Phase 06 complete. This phase is
UI-heavy; keep the timeline STATE pure and tested, the React layer thin.

## Requirements

- `src/lib/timeline/` — pure state model + operations (no React):
  - Timeline doc per clip in `clip_edits.timeline`: ordered video segments
    (each a source in/out range), caption track ref, overlay track (B-roll/
    CTA slots — populated in Phase 08), audio settings (volume, mute).
  - Operations, each `(doc, args) → doc` (immutable): `trim(segId, edge, t)`,
    `splitAt(t)`, `deleteSegment(segId)`, `reorder(segId, toIndex)`,
    `totalDuration(doc)`, `sourceTimeAt(doc, timelineT)` and inverse.
  - Invariants enforced by every op: segments non-empty, in < out, all
    within clip bounds; captions re-map through `sourceTimeAt`.
- Editor page `/clips/[id]` gains a timeline strip:
  - tracks: video segments (thumbnails), captions, overlays, audio
  - drag handles to trim; playhead; click-to-seek; split at playhead;
    delete/reorder segments; zoom in/out; snapping to segment edges and
    caption boundaries
  - keyboard: space play/pause, S split, Del delete, ←/→ frame step
  - preview plays the EDITED sequence (skips deleted ranges, honors order)
    using timeupdate-based seeking of the single `<video>` element
  - undo/redo (state stack over the pure doc, ≥50 steps)
- Persist edits: debounced `PATCH /api/clips/:id/timeline`; optimistic UI.

## Constraints

- All timeline math in the pure lib — components contain no time arithmetic.
- No new rendering/ffmpeg work in this phase.
- No canvas-based custom video compositing; single `<video>` + DOM overlays.

## Acceptance Criteria

- `npm test` exits 0, including:
  - op unit tests: trim clamps to neighbors, split produces two contiguous
    segments, delete+reorder keep invariants, undo/redo round-trips
  - property test: for random op sequences, `totalDuration` equals the sum
    of segment lengths and `sourceTimeAt`∘inverse is identity (±1 ms)
  - caption re-mapping: after splitting and deleting a middle segment,
    caption lines over deleted ranges are excluded, others shift correctly
  - PATCH timeline persists and reloads identically
- Playwright: open editor on a seeded clip, split at playhead, delete the
  second segment, reload page → timeline shows the persisted result
  (`npm run test:e2e` exits 0)
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-07: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [x] Pure timeline doc model + all ops with invariants
- [x] Caption re-mapping through edits
- [x] Timeline strip UI (tracks, trim, split, reorder, zoom, snapping)
- [x] Edited-sequence preview playback
- [x] Undo/redo
- [x] Persistence API (GET/PATCH /api/clips/:id/timeline)
- [x] Optimistic client save wiring (debounced PATCH from editor — with UI item)
- [x] Playwright e2e for split/delete/persist
- [x] All acceptance criteria verified in one iteration
- [x] PHASE_COMPLETE

## Completion signal (ralph-orchestrator)

When every Status box above is checked and all acceptance criteria were
verified passing in this same iteration: check `- [x] PHASE_COMPLETE`,
commit, then end your output with exactly this single line:

LOOP_COMPLETE

Never output that string in any other situation — not in progress summaries,
code, or commit messages. If you are working under the PROMPT.md masterprompt
instead of this file, follow ITS completion signal and just check the boxes
here.
