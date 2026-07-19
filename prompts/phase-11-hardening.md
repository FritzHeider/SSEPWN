# Phase 11: Dashboard, e2e journey, hardening

Read `SPEC.md` first. Prerequisite: Phase 10 complete. Final phase — make
the whole product coherent and prove the full journey works.

## Requirements

- **Dashboard** (`/`): project cards with thumbnail, duration, status,
  clip count, export count; create/delete project (delete cleans up files +
  rows — cascade test); per-project page ties together transcript, clips
  grid (with thumbnails generated at clip in-point), and pipeline status
  stepper (uploaded → transcribed → clips ready).
- **Pipeline orchestration**: one `process` job chain runs ingest →
  transcribe → generate-clips automatically on upload; failures stop the
  chain with a resumable "retry from failed step" action.
- **Empty/edge states**: no-audio project (clips by scene/energy only,
  captions disabled with explanation), zero-highlight video (offer manual
  clipping), very short upload (< min clip length → whole video becomes one
  clip).
- **Full-journey Playwright test** (`npm run test:e2e`): upload fixture →
  wait for pipeline (fake transcriber) → open top clip → edit a caption
  word → switch to 9:16 → apply tiktok-bold template → split timeline and
  delete a segment → export draft tiktok → download response is a valid mp4
  (probe in the test via API or file size + magic bytes).
- **Hardening**:
  - API input validation everywhere (zod), consistent JSON error shape
  - worker: crashed-mid-job recovery (running jobs older than a timeout are
    re-queued on worker start — test it)
  - concurrent upload of 3 fixtures processes all successfully
  - `npm run check` script = lint + typecheck + test + build
- **Docs**: README covers setup (including optional real whisper + Human
  models), architecture overview (pipeline diagram in ASCII), and a
  troubleshooting section (ffmpeg missing, whisper missing, model download).

## Constraints

- No new product features beyond SPEC. Resist gold-plating — this phase
  ends the project.
- Do not rewrite working subsystems; only fix what the journey test and
  hardening items expose.

## Acceptance Criteria

- `npm run check` exits 0
- `npm run test:e2e` exits 0 including the full-journey test
- Stale-running-job recovery test green
- Cascade-delete test green (no orphan rows: assert counts across all
  tables; no orphan files under `data/` for the deleted project)
- `grep -r "TODO\|FIXME" src/ --include="*.ts" --include="*.tsx" | wc -l`
  returns 0 (resolve or convert to README "known limitations")
- README instructions verified by running them verbatim in a clean clone
  (delete node_modules + data, follow README, `npm run check` passes)

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-11: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [x] Dashboard + project page polish + status stepper
- [x] Auto pipeline chain + retry-from-failed-step
- [ ] Edge states (no audio, no highlights, very short)
- [ ] Full-journey Playwright test green
- [ ] Validation + error shape + worker crash recovery
- [ ] Concurrent-upload test green
- [ ] Cascade delete + no orphans
- [ ] README verified in clean clone
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
