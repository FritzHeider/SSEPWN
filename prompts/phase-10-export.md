# Phase 10: Export pipeline (render the plan)

Read `SPEC.md` first. Prerequisite: Phase 09 complete. This phase executes
the `renderPlan` structure from Phase 08 with real ffmpeg.

## Requirements

- `src/lib/render/execute.ts`: compile a renderPlan into ffmpeg invocation(s)
  and run them:
  - segment cuts + concat, xfade transitions, crop+scale to preset
    resolution, B-roll overlay (pip via overlay filter, full via timeline
    switching), CTA text via drawtext / image via overlay with fade, caption
    burn-in via ass filter, SFX mixed via amix/adelay with optional
    sidechain ducking, loudness normalize (loudnorm) to -14 LUFS
  - multi-step (intermediate files in a temp dir) is acceptable and often
    more robust than one mega-filtergraph; clean up intermediates
  - progress: parse ffmpeg `-progress` output → job progress 0–100
- `export` job type: input clipId + platform preset; output
  `data/exports/<clip>-<preset>.mp4`; row in `exports` table; H.264 high +
  AAC 192k, `+faststart`, preset resolution from Phase 09 constants.
- Quality presets: `draft` (fast, crf 28, 720-width class) and `final`
  (crf 19). Draft used by a "quick preview render" button.
- API: `POST /api/clips/:id/export { preset, quality }`,
  `GET /api/exports/:id` (status/progress), `GET /api/exports/:id/download`
  (file stream, correct Content-Type/Disposition).
- UI: export dialog (preset + quality), per-export progress bar, download
  button, export history per clip; batch "export all clips" on the project
  page (queues one job per clip; the worker processes sequentially).
- Failure paths: ffmpeg nonzero exit captures stderr tail into job error;
  UI shows a readable failure with retry button.

## Constraints

- Keep default test runtime sane: integration tests render ≤10 s draft
  clips from fixtures only.
- Never end an iteration red — if a filter chain fights you, commit the
  passing subset and note the failing case in the phase checklist.

## Acceptance Criteria

- `npm test` exits 0, including integration tests (fixtures, draft quality):
  - plain clip (2 segments, cut) exports; probe: expected duration ±0.3 s,
    1080×1920 for tiktok preset, h264 + aac streams, faststart flag set
  - crossfade export duration = segments − overlap ±0.3 s
  - captions burn-in export: extract a frame during a caption line and
    assert it differs from the same frame of a captionless render (pixel
    diff > threshold — proves burn-in happened)
  - pip B-roll + CTA image export completes; probe OK
  - SFX export: audio stream present; with ducking on, main-audio RMS
    during SFX window is lower than without (measure via ffmpeg astats)
  - failing input (deleted source file) → job `failed` with error message,
    retry after restoring file succeeds
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration. Natural sub-chunks: base cut/concat →
  transitions → overlays/CTA → captions → audio/SFX → progress/UI.
- Commit working increments (`phase-10: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, which ffmpeg features now
  render, and gate results.

## Status

- [x] execute.ts: cuts + concat + crop/scale
- [x] Transitions (xfade) rendering
- [x] B-roll (pip + full) rendering
- [x] CTA overlays (drawtext/image + fades) rendering
- [x] Caption burn-in in full pipeline
- [x] SFX mix + ducking + loudnorm
- [x] Progress parsing → job progress
- [x] Export job handler: compile clip edit → render → data/exports file + exports row (jobId/error columns)
- [ ] Export API: POST /api/clips/:id/export + GET /api/exports/:id + /download + quality presets
- [ ] Export UI + batch export + failure/retry
- [ ] All listed integration tests green
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
