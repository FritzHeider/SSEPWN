# Phase 04: Highlight detection + auto-clipping

Read `SPEC.md` first. Prerequisite: Phase 03 complete. This is the core AI
feature — invest in making it deterministic and testable.

## Requirements

- `src/lib/highlights/` with pure, unit-testable functions:
  - `audioEnergy(wavPath)`: RMS energy per 1 s window (ffmpeg
    `astats`/`ebur128` or decode+compute) → number[]
  - `sceneChanges(videoPath)`: timestamps via ffmpeg scene-detect filter
  - `scoreWindows(transcript, energy, opts)`: slide a window (15–90 s,
    configurable) and score each candidate from named signals:
    energy peak vs neighborhood, speech density (words/s), hook phrases
    (configurable list: "the secret", "here's why", "nobody tells you", …),
    exclamations/questions, laughter markers. Returns candidates with a
    total score AND per-signal breakdown (these become the human-readable
    "reasons").
  - `snapBoundaries(candidate, transcript, scenes)`: expand/shrink to the
    nearest sentence boundary; prefer a scene change within 1.5 s; NEVER cut
    inside a word's [start,end].
  - `selectClips(candidates, n, minGap)`: top-N non-overlapping, ≥5 s apart.
- `generate-clips` job type + handler: runs after transcription; writes
  `clips` rows (in/out, score, reasons, auto title = first hook sentence
  trimmed to 60 chars); default n from project settings (5–10).
- Config surface: clip length min/max, clip count, hook-phrase list — stored
  per project, editable via API.
- API: `GET /api/projects/:id/clips`, `POST /api/projects/:id/clips`
  (manual clip from in/out), `DELETE /api/clips/:id`,
  `POST /api/projects/:id/regenerate-clips`.
- UI: clips panel on project page — ranked cards with score, reasons,
  duration, in/out; clicking previews that range in the player (seek +
  pause at out-point); manual "add clip from current selection" control.

## Constraints

- Pure functions take data, not DB handles — all scoring logic must be
  testable without ffmpeg or a database.
- No LLM calls, no network. Scorer sits behind the `HighlightScorer`
  interface from SPEC so one can be added later.
- Deterministic: same inputs → same clips (no randomness).

## Acceptance Criteria

- `npm test` exits 0, including:
  - scoreWindows unit tests on the fixture transcript + synthetic energy
    array: the loud/hook-dense region outranks quiet filler regions
  - snapBoundaries property tests: output in/out never fall strictly inside
    any word interval; out − in stays within [minLen, maxLen]
  - selectClips returns non-overlapping, correctly ordered clips
  - end-to-end (fake transcriber, fixture video): generate-clips job yields
    ≥3 clips, each 15–90 s, each with ≥1 named reason, ranked by score
  - regenerate with a custom hook-phrase list changes which clip ranks first
    (proves config is live)
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-04: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [x] audioEnergy + sceneChanges extractors
- [x] scoreWindows with per-signal breakdown
- [ ] snapBoundaries (sentence/scene snapping, never mid-word)
- [ ] selectClips top-N non-overlapping
- [ ] generate-clips job handler + pipeline wiring
- [ ] Clip config per project + APIs (list/add/delete/regenerate)
- [ ] Clips UI panel with range preview
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
