# Phase 09: Templates + platform presets

Read `SPEC.md` first. Prerequisite: Phase 08 complete.

## Requirements

- **Template model** (`templates` table — add migration): name, caption
  style/preset, aspect ratio, CTA entries, brand colors (primary/secondary
  used by caption highlight + CTA bg), optional watermark image assetId.
- **Built-in templates** seeded on migrate: `tiktok-bold` (9:16, bold-pop
  captions, "Follow for more" CTA), `shorts-clean` (9:16, clean-sub),
  `reels-minimal` (9:16, minimal-caps). Seeding idempotent.
- **Apply template** `POST /api/clips/:id/apply-template { templateId }`:
  overwrites caption style, AR (enqueues smart-crop if AR changes), CTAs,
  watermark — but NEVER touches segment edits/trims. Applying is undoable
  (snapshot previous clip_edits state).
- **Save as template**: from a clip's current edit state.
- **Platform presets** (`src/lib/presets.ts`): the table from SPEC
  § Platform presets as typed constants (AR, resolution, max-length warning,
  burnCaptions). Project-level default preset; per-clip override. UI shows a
  warning badge when a clip exceeds its preset's max length ("Shorts ≤60 s").
- **Template UI**: template gallery (built-ins + saved) with visual style
  swatches; apply from clip editor; manage page to rename/delete saved
  templates (built-ins undeletable).

## Constraints

- Template application logic is a pure function
  `applyTemplate(clipEdit, template) → clipEdit` — unit-tested; the API
  route just wraps it.
- Do not implement rendering/export (Phase 10).

## Acceptance Criteria

- `npm test` exits 0, including:
  - seed idempotency: running migrate/seed twice yields exactly 3 built-ins
  - applyTemplate replaces style/CTA/AR but preserves segments, trims, SFX,
    and manual-locked crop keyframes
  - apply-then-undo restores the exact previous clip_edits JSON
  - max-length warning logic: 61 s clip + youtube-shorts preset → warning;
    59 s → none
  - save-as-template round-trip: save from clip A, apply to clip B, B's
    caption style deep-equals A's
- Playwright: apply `tiktok-bold` to a seeded clip → caption preview class/
  style changes and CTA appears (`npm run test:e2e` exits 0)
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-09: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [x] templates table + migration + idempotent seed of 3 built-ins
- [x] applyTemplate pure function + undo snapshot
- [x] Save-as-template
- [x] Platform preset constants + per-project/per-clip selection
- [ ] Max-length warning badges
- [ ] Template gallery + manage UI
- [ ] Playwright e2e for apply-template
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
