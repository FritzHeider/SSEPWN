# Phase 05: Auto captions (styled, editable, burn-in)

Read `SPEC.md` first. Prerequisite: Phase 04 complete.

## Requirements

- `src/lib/captions/`:
  - `clipCaptions(transcript, clipIn, clipOut)`: slice word-timed captions
    for a clip, re-based to clip-relative time; group words into caption
    lines (max chars/line and max 2 lines, configurable).
  - Caption doc stored in `clip_edits.captions`: lines of words with
    timings + per-clip style object.
  - Style model: fontFamily, fontSize, textColor, highlightColor (spoken-word
    karaoke), strokeColor/width, background box on/off, position
    (top/middle/bottom + margin), uppercase on/off.
  - ≥4 style presets: `bold-pop` (TikTok-style chunky, karaoke on),
    `clean-sub` (classic bottom subtitle), `minimal-caps`, `boxed`.
  - `toAss(captionDoc, videoW, videoH)`: render to `.ass` — presets map to
    ASS styles; karaoke uses `\k` tags from word timings.
  - `burnIn(inputPath, assPath, outputPath)` in `src/lib/ffmpeg/` using the
    `ass` filter.
- Caption editing API: `PATCH /api/clips/:id/captions` — edit word text,
  merge/split lines, shift timing of a line, change style/preset.
- UI (clip editor page `/clips/[id]`): caption list synced to preview
  (active line highlighted while playing); inline text editing; style panel
  with presets + controls; live overlay preview rendered in HTML/CSS
  approximating the style (burn-in exactness is verified at export).
- Word edits must NOT mutate the project transcript — clip-local copy only.

## Constraints

- Caption math (slicing, grouping, re-basing, ASS generation) is pure and
  unit-tested without ffmpeg.
- Don't build export presets/pipeline yet (Phase 10); `burnIn` is a lib
  function proven by one integration test.

## Acceptance Criteria

- `npm test` exits 0, including:
  - clipCaptions re-bases timings correctly and drops words outside range
    (partial-overlap words clamped, not dropped)
  - line grouping respects maxChars and never splits a word
  - toAss output contains a Style line per preset and `\k` tags whose
    durations sum to each line's word-time span (parse the generated ASS in
    the test)
  - PATCH caption edit persists and does not alter `transcripts` rows
  - integration: burnIn on `short-sample.mp4` with a 2-line ASS produces a
    playable mp4 (probe: same duration ±0.2 s, video stream present)
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-05: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [ ] clipCaptions slice/re-base + line grouping
- [ ] Style model + 4 presets
- [ ] toAss with karaoke tags
- [ ] burnIn ffmpeg function + integration test
- [ ] Caption edit API (text/timing/style) with clip-local isolation
- [ ] Clip editor caption UI with live styled preview
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
