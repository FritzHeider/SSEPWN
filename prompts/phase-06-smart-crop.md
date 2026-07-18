# Phase 06: Smart crop (subject-tracked reframing)

Read `SPEC.md` first. Prerequisite: Phase 05 complete.

## Requirements

- `src/lib/crop/`:
  - `SubjectDetector` interface: `detect(framePngPath): Promise<Box[]>`
    (normalized 0–1 boxes with confidence).
  - `HumanFaceDetector` impl via @vladmandic/human (CPU/wasm backend, models
    vendored or downloaded once by `scripts/make-fixtures.sh` — document
    size). `FakeDetector` for tests returns scripted boxes per frame index.
  - `sampleFrames(videoPath, everyNSec)`: extract sample frames via ffmpeg.
  - `planCrop(boxes[], srcW, srcH, targetAR)`: pure function → crop
    keyframes `{ t, x, y, w, h }[]`:
    - crop window has exactly targetAR, maximal size fitting the source
    - centers on the highest-confidence subject; center-weighted fallback
      when no subject
    - temporal smoothing: window moves only when subject leaves a dead-zone,
      eased over ≥0.5 s, max pan speed capped (no jitter — assert in tests)
  - `cropFilter(keyframes)`: build the ffmpeg crop+scale filter expression
    (piecewise-linear interpolation between keyframes).
- `smart-crop` job per clip + aspect ratio; result stored in
  `clip_edits.crop` (keyframes + chosen AR: 9:16, 1:1, 16:9).
- API: `POST /api/clips/:id/crop { aspectRatio }` (enqueue),
  `PATCH /api/clips/:id/crop` (manual keyframe override).
- UI (clip editor): AR switcher (9:16 / 1:1 / 16:9); crop rectangle overlaid
  on the preview, draggable to override position at the current time
  (writes a manual keyframe); "re-run auto" button.

## Constraints

- `planCrop`/`cropFilter` are pure — unit-tested with FakeDetector data, no
  ffmpeg, no TF.js.
- Default `npm test` must not require Human models (FakeDetector); one
  optional smoke test behind `CROP_SMOKE=1`.
- Preview shows the crop as an overlay — do NOT render cropped video files
  during editing (rendering is Phase 10).

## Acceptance Criteria

- `npm test` exits 0, including:
  - planCrop returns exact target AR within 1 px for 9:16, 1:1, 16:9 on a
    1280×720 source
  - subject-follow test: scripted boxes moving left→right produce keyframes
    whose x is non-decreasing and pan speed ≤ cap
  - dead-zone test: boxes jittering ±2% produce a single stationary keyframe
  - no-subject fallback: center crop
  - cropFilter output parses (feed it to a real ffmpeg run on
    `short-sample.mp4` in one integration test; probe output has target AR
    dimensions)
  - manual override PATCH persists and survives "re-run auto" only when
    flagged `locked: true`
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-06: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [x] SubjectDetector interface + types (Box/AspectRatio) + FakeDetector
- [x] HumanFaceDetector impl (@vladmandic/human, models via make-fixtures.sh)
- [x] Frame sampling
- [x] planCrop with smoothing/dead-zone/fallback (pure)
- [x] cropFilter expression builder + one real ffmpeg integration test
- [x] smart-crop job + storage in clip_edits
- [x] Crop APIs (auto enqueue, manual override, locked keyframes)
- [ ] Editor UI: AR switcher + draggable crop overlay
- [ ] All listed tests green without TF models
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
