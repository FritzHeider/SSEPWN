# Phase 02: Media ingestion, job queue, worker

Read `SPEC.md` first. Prerequisite: Phase 01 complete.

## Requirements

- **Upload API**: `POST /api/projects` accepts multipart video upload
  (mp4/mov/webm, ≤2 GB streamed to `data/uploads/`, never buffered fully in
  memory). Creates a `projects` row + an `ingest` job. Rejects wrong
  mime/extension and oversize with 400 + JSON error body.
- **Job queue**: `src/lib/jobs/` — enqueue(type, projectId, payload),
  claim-next (atomic status flip queued→running using a single UPDATE ...
  WHERE), heartbeat/progress update, complete, fail(error). Retry: a failed
  job retries up to 2 times with backoff; then status `failed`.
- **Worker**: `npm run worker` polls the jobs table (500 ms), claims one job
  at a time, dispatches by type to handlers in `src/worker/handlers/`.
  Graceful shutdown on SIGINT (finishes current job). Handler registry is
  extensible — later phases only add handlers.
- **Ingest handler**: probes the upload, stores metadata on the project,
  generates a poster thumbnail (`ffmpeg -ss ... -frames:v 1`), sets project
  status `ready`; sets `failed` with a human-readable error for bad files.
- **Status API**: `GET /api/projects`, `GET /api/projects/:id` (includes job
  progress), `GET /api/jobs/:id`.
- **Minimal UI**: `/` page with drag-drop upload, project list with status
  badge + thumbnail, auto-refresh (polling is fine).

## Constraints

- No transcription/clipping logic yet (Phases 03–04).
- All media work in the worker; API handlers only enqueue and read.
- Job claiming must be safe if two workers run concurrently (write a test
  that spins the claim function from two callers and asserts a job is
  claimed exactly once).

## Acceptance Criteria

- `npm test` exits 0, including new tests:
  - upload happy path creates project + queued ingest job (use fixture
    `short-sample.mp4`)
  - `not-a-video.txt` upload → 400 JSON error
  - worker processes ingest job end-to-end: project becomes `ready` with
    duration/resolution set and thumbnail file existing
  - `no-audio.mp4` ingests successfully with `hasAudio=false`
  - double-claim test: one job claimed exactly once
  - failed-then-retry test: handler that throws twice then succeeds → job
    ends `done` with attempts=3
- `npm run lint`, `npm run typecheck`, `npm run build` exit 0

## Iteration Rules

- Re-read this file + `SPEC.md` each iteration; `git log --oneline -10` first.
- Finish in-progress items before new ones; split oversized items into new
  checklist lines and end the iteration.
- Commit working increments (`phase-02: <what>`); no uncommitted work at
  iteration end.
- Output must name files changed, items flipped, and gate results this
  iteration.

## Status

- [x] Job queue lib with atomic claim + retry/backoff
- [x] Worker loop with handler registry + graceful shutdown
- [x] Upload API with streaming + validation
- [ ] Ingest handler (probe, thumbnail, status transitions)
- [ ] Status/read APIs
- [ ] Upload + project list UI
- [ ] All listed tests written and green
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
