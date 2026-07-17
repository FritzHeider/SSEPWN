# Phase 03: Transcription (whisper.cpp behind an interface)

Read `SPEC.md` first. Prerequisite: Phase 02 complete.

## Requirements

- `src/lib/transcribe/types.ts`: `Transcriber` interface —
  `transcribe(audioPath): Promise<TranscriptSegment[]>` where segments carry
  sentence text, start/end, and word-level `{ word, start, end }[]`.
- `WhisperCppTranscriber`: extracts 16 kHz mono WAV via ffmpeg, spawns the
  whisper.cpp binary (path + model path from env `WHISPER_BIN`,
  `WHISPER_MODEL`, defaults documented in README), parses its JSON output
  into `TranscriptSegment[]`. Missing binary → clear actionable error.
- `FakeTranscriber`: loads fixture transcripts from
  `fixtures/transcripts/*.json`. Create a realistic 90 s fixture transcript
  for `long-sample.mp4` (~15 sentences with word timings, include some hook
  phrases like "here's the secret", a "[laughter]" marker, and quiet filler
  sections — Phase 04 heuristics will feed on this).
- Transcriber selection via factory: env `TRANSCRIBER=fake|whisper`
  (default whisper in dev, fake in tests).
- `transcribe` job type + worker handler: runs after ingest for projects
  with audio; writes to `transcripts` table; project gets a
  `transcribed` status flag. Projects without audio skip cleanly (status
  notes "no audio — captions unavailable").
- API `GET /api/projects/:id/transcript`; UI: transcript panel on the
  project page showing sentences with timestamps; clicking a sentence seeks
  the `<video>` preview.
- Optional real-whisper smoke test, skipped unless `WHISPER_SMOKE=1`.

## Constraints

- Default `npm test` must pass with NO whisper binary installed and NO
  network (FakeTranscriber only).
- Do not start highlight scoring — Phase 04.

## Acceptance Criteria

- `npm test` exits 0, including:
  - WAV-extraction unit test (probe output: 16 kHz mono)
  - whisper JSON-output parser test against a checked-in sample of
    whisper.cpp output format (small JSON text fixture is fine to commit)
  - end-to-end: ingest `long-sample.mp4` with TRANSCRIBER=fake → transcript
    rows exist with word timings monotonic and within video duration
  - no-audio project skips transcription without failing the pipeline
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit working increments (`phase-03: <what>`); no uncommitted work at end.
- Output must name files changed, items flipped, and gate results.

## Status

- [ ] Transcriber interface + types
- [ ] WhisperCppTranscriber (wav extract, spawn, parse, errors)
- [ ] FakeTranscriber + rich 90 s fixture transcript JSON
- [ ] Factory + env selection
- [ ] transcribe job handler wired into pipeline after ingest
- [ ] Transcript API + UI panel with seek-on-click
- [ ] All listed tests green with no whisper binary present
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
