# Phase 08: B-roll, transitions, sound effects, CTA overlays

Read `SPEC.md` first. Prerequisite: Phase 07 complete.

## Requirements

- **Asset library**: `POST /api/assets` upload (video for B-roll, audio for
  SFX, png/jpg for logos/CTA images), typed + probed; `GET /api/assets`
  filterable by kind; thumbnails for video/image assets; asset picker UI.
- **B-roll** (overlay track from Phase 07):
  - slot model: assetId, timeline range, mode `pip` (position + scale) or
    `full` (replaces main video image, main audio continues)
  - editor: insert from picker at playhead, drag to move/resize range,
    switch mode, remove
  - preview: `full` shows the B-roll in a second, absolutely-positioned
    muted `<video>`; `pip` shows a floating video box
- **Transitions**: per segment boundary — `cut` (default), `crossfade`,
  `slide-left/right`, duration 0.2–1.5 s; picker in the timeline between
  segments; stored on the timeline doc; validation: transition shorter than
  both adjacent segments.
- **Sound effects**: SFX track entries {assetId, t, volume, duckMain?};
  editor to place at playhead, nudge, set volume; preview via WebAudio
  (fetch decoded once, schedule on play).
- **CTA overlays**: overlay entries {kind: text|image, content/assetId,
  position (9-grid + offset), range, animIn/animOut: none|fade|slide,
  style: font/size/color/bg}; ≥2 built-in text CTA presets ("Follow for
  more", "Link in bio"); live DOM preview with CSS animations.
- Extend `src/lib/render/plan.ts` (create it): `renderPlan(clipEdit)` — a
  PURE function that compiles the full edit doc (segments, transitions,
  B-roll, SFX, CTAs, captions, crop) into an ordered ffmpeg filter-graph
  plan (typed structure, not a string). Phase 10 will execute it; this
  phase must make it COMPLETE for every feature above.

## Constraints

- Preview approximates; renderPlan is the ground truth — every feature added
  here must appear in renderPlan output and be unit-tested.
- No actual ffmpeg execution of the full plan yet (Phase 10), except keep
  existing integration tests green.

## Acceptance Criteria

- `npm test` exits 0, including:
  - asset upload/type-detection tests (video/audio/image, reject others)
  - B-roll slot validation: ranges clamp to timeline, pip geometry within
    frame
  - transition validation rejects durations longer than a neighbor segment
  - renderPlan unit tests: given a doc with 2 segments + crossfade + 1 pip
    B-roll + 1 SFX + 1 text CTA + captions + 9:16 crop, the plan contains
    each corresponding node exactly once, in dependency order (assert on
    the typed structure)
  - renderPlan is deterministic (same doc → deep-equal plan)
- Playwright: place a B-roll slot and a CTA on a seeded clip, reload,
  both persist and render in preview DOM (`npm run test:e2e` exits 0)
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration. This phase is the largest — expect to
  split it; B-roll, transitions, SFX, and CTA are natural sub-chunks.
- Commit working increments (`phase-08: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [x] Asset library: schema + kind detection + upload/list API
- [x] Asset library: worker probe + thumbnails (job handler)
- [ ] Asset library: asset picker UI
- [x] B-roll slots: model + ops + validation (pure lib)
- [ ] B-roll slots: editor + preview (pip and full)
- [x] Transitions: model + validation (pure lib)
- [ ] Transitions: picker UI (between segments)
- [x] SFX track: model + ops + validation (pure lib)
- [ ] SFX track: editor + WebAudio preview UI
- [ ] CTA overlays: model + presets + animated DOM preview
- [ ] renderPlan pure compiler covering ALL features
- [ ] Playwright e2e for B-roll + CTA persistence
- [ ] All listed tests green
- [ ] All acceptance criteria verified in one iteration
- [ ] PHASE_COMPLETE

## Completion signal (ralph-orchestrator)

When every Status box above is checked and all acceptance criteria were
verified passing in this same iteration: check `- [x] PHASE_COMPLETE`,
commit, then end your output with exactly this single line:

LOOP_COMPLETE

Never output that string in any other situation — not in progress summaries,
code, or commit messages. If you are working under the PROMPT.md masterprompt
instead of this file, follow ITS completion signal and just check the boxes
here.
