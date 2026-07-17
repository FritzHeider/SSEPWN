# Phase 01: Scaffold, quality gates, test fixtures

Read `SPEC.md` first. This phase creates the repo skeleton and — most
importantly — the backpressure gates every later phase depends on.

## Requirements

- Next.js 15+ App Router project, TypeScript strict, Tailwind, ESLint.
- npm scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:watch`,
  `worker` (runs `src/worker/index.ts` via tsx), `fixtures` (runs
  `scripts/make-fixtures.sh`), `db:migrate`.
- Drizzle + better-sqlite3 wired up; schema for ALL tables in
  `SPEC.md` § Data model (empty-but-migrated is fine); DB file at
  `data/sseclone.db`; `data/` gitignored.
- `src/lib/ffmpeg/exec.ts`: thin execa wrapper `runFfmpeg(args: string[])`
  and `probe(path): Promise<ProbeResult>` (parses ffprobe JSON: duration,
  width, height, fps, hasAudio).
- `scripts/make-fixtures.sh`: generates into `fixtures/` (gitignored):
  - `long-sample.mp4` — 90 s, 1280×720, testsrc2 video + sine audio that
    alternates loud/quiet every 10 s (gives highlight heuristics signal)
  - `short-sample.mp4` — 5 s with audio
  - `no-audio.mp4` — 5 s, video only
  - `broll-sample.mp4` — 8 s
  - `not-a-video.txt`
  Script is idempotent and skips files that already exist.
- Vitest configured; a `describe('ffmpeg')` integration test that probes
  `fixtures/short-sample.mp4` and asserts duration ≈5 s, 1280×720, hasAudio;
  and asserts `probe('fixtures/not-a-video.txt')` rejects.
- `README.md` with setup: prerequisites (node 20+, ffmpeg), then
  `npm install && npm run fixtures && npm run db:migrate && npm test`.

## Constraints

- Do not build any product features (no upload UI, no jobs logic) — that is
  Phase 02. Scope creep here is the main failure mode.
- No binary files committed. CI-style checks must run offline.

## Acceptance Criteria

- `npm run fixtures` exits 0 and creates the five fixture files
- `npm run db:migrate` exits 0; `sqlite3 data/sseclone.db ".tables"` lists
  projects, assets, jobs, transcripts, clips, clip_edits, exports
- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0 (includes the ffmpeg probe tests)
- `npm run build` exits 0

## Iteration Rules

- Re-read this file and `SPEC.md` at the start of every iteration; run
  `git log --oneline -10` to see prior work.
- Finish in-progress items first; split oversized items into new checklist
  lines here and end the iteration.
- Commit each working increment (`phase-01: <what>`); never end an iteration
  with uncommitted work.
- Output must state which items flipped this iteration and gate results.

## Status

- [x] Next.js + TS strict + Tailwind + ESLint scaffold
- [x] npm scripts wired (dev/build/lint/typecheck/test/worker/fixtures/db:migrate)
- [ ] Drizzle schema + migration for all SPEC tables
- [ ] ffmpeg exec wrapper + probe with types
- [ ] make-fixtures.sh generating all five fixtures, idempotent
- [ ] ffmpeg probe integration tests green
- [ ] README runnable end-to-end on a fresh machine
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
