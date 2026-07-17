# Sseclone — AI video clipping tool

Turns long-form video (podcasts, streams, webinars, lectures) into short,
social-ready clips: transcription → AI highlight detection → auto-clipping →
styled captions → smart crop → enhancements → platform-ready MP4 exports.
See `SPEC.md` for the full product spec.

Everything runs locally: Next.js (App Router) + a Node worker process,
SQLite (better-sqlite3 + Drizzle), and system FFmpeg via `execa`. No Docker,
no Redis, no API keys, no GPU.

## Prerequisites

- Node.js 20+
- `ffmpeg` and `ffprobe` on PATH (test fixtures are generated with them)
- `sqlite3` CLI (optional, for inspecting the database)

## Setup

```bash
npm install
npm run fixtures     # generate test media into fixtures/ (idempotent)
npm run db:migrate   # create data/sseclone.db and apply migrations
npm test             # vitest unit + integration suite
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm run worker` | Media-processing worker (`src/worker/index.ts` via tsx) |
| `npm run fixtures` | Generate test media via `scripts/make-fixtures.sh` |
| `npm run db:migrate` | Apply Drizzle migrations to `data/sseclone.db` |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `npm run test:watch` | Vitest |

## Repo layout

- `src/lib/ffmpeg/` — all FFmpeg/ffprobe invocations (execa arg arrays only)
- `src/lib/db/` — Drizzle schema + client; migrations in `drizzle/`
- `src/worker/` — job-queue worker for long-running media work
- `scripts/make-fixtures.sh` — generates test media (never commit binary media)
- `tests/` — vitest suites
- `fixtures/`, `data/` — generated media and the SQLite DB (both gitignored)

## Orchestration pack

This repo is being built by ralph-orchestrator. `PROMPT.md` is the
masterprompt, `prompts/phase-NN-*.md` are the per-phase prompts, and
`ralph.yml` is the loop config. See those files for how the build loop works;
they are not needed to run the app.
