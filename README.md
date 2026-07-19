# Sseclone — AI video clipping tool

Turns long-form video (podcasts, streams, webinars, lectures) into short,
social-ready clips: transcription → AI highlight detection → auto-clipping →
styled captions → smart crop → enhancements → platform-ready MP4 exports.
See `SPEC.md` for the full product spec.

Everything runs locally: Next.js (App Router) + a Node worker process,
SQLite (better-sqlite3 + Drizzle), and system FFmpeg via `execa`. No Docker,
no Redis, no API keys, no GPU.

## Architecture

The Next.js app never does media work in a request handler — it only writes
rows and enqueues jobs into a SQLite `jobs` table. A separate worker process
(`npm run worker`) polls that table, claims one job at a time, and runs the
long FFmpeg/whisper/detector work. Uploading a video enqueues a single
`ingest` job; each pipeline handler enqueues the next step on success, so the
whole chain runs automatically:

```
  Browser (Next.js UI)
        │  upload
        ▼
  POST /api/projects ──────────► data/uploads/<uuid>  (source file)
        │  INSERT project + asset rows
        │  ENQUEUE ingest
        ▼
  jobs table (SQLite)  ◄─────────────── enqueue next step on success
        ▲                                              │
        │ claim (1 at a time, run_at/attempts)         │
        │                                              │
  Worker loop (src/worker) ──────────────────────────┘
        │
        ├─ ingest        probe duration/streams, thumbnail ─┐ enqueue
        │                                                   ▼
        ├─ transcribe    whisper → words/segments  (no audio → skip) ─┐
        │                                                             ▼
        └─ generate-clips highlight detection → auto-clips ───────────┘
                                     │
        on-demand, per user action:  ├─ smart-crop   (9:16 / 1:1 / 16:9 reframe)
                                     └─ export        timeline → captions/crop
                                                      → platform-ready .mp4
```

Failures stop the chain and mark the job `failed`; the project page offers a
**retry from the failed step** action that re-queues the earliest failed
pipeline job with its payload intact. A worker that crashes mid-job leaves the
row `running`; on the next worker start `recoverStale()` re-queues rows older
than the stale timeout (or fails them once attempts are exhausted, so a poison
job cannot loop forever).

Key modules: `src/lib/ffmpeg/` (every ffmpeg/ffprobe call, execa arg arrays
only), `src/lib/jobs/` (queue + claim/recovery), `src/worker/handlers/` (one
file per job type), `src/lib/transcribe/`, `src/lib/highlights/`, `src/lib/crop/`,
and `src/lib/export/`.

## Prerequisites

- Node.js 20+
- `ffmpeg` and `ffprobe` on PATH (test fixtures are generated with them).
  Caption burn-in (`burnIn`, the `ass` filter) needs an ffmpeg built with
  **libass**; most distributions ship it (`brew install ffmpeg`), but a minimal
  build without it will skip the burn-in integration test rather than fail.
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
| `npm run test:e2e` | Playwright end-to-end (full upload→export journey + timeline editor) |
| `npm run check` | Full gate: `lint && typecheck && test && build` (run before committing) |

### End-to-end tests (Playwright)

`npm run test:e2e` drives the real editor in a headless browser. Install the
browser once (the config seeds its own throwaway DB + a generated source video
via ffmpeg, and does a production `next build` before serving, so nothing else
is required):

```bash
npx playwright install chromium
npm run test:e2e
```

## Transcription

Transcription runs through the `Transcriber` interface (`src/lib/transcribe/`),
so the test suite never needs whisper installed — `npm test` passes with no
whisper binary and no model present.

| Env var | Default | What it is |
|---|---|---|
| `TRANSCRIBER` | `fake` under `NODE_ENV=test`, else `whisper` | Which implementation to use: `fake` replays a checked-in transcript, `whisper` runs the real binary |
| `WHISPER_BIN` | `whisper-cli` | Path to the built whisper.cpp CLI |
| `WHISPER_MODEL` | `models/ggml-base.en.bin` | Path to a ggml model file |

`TRANSCRIBER=fake` replays `tests/samples/transcripts/<name>.json`, which is how
the suite runs without whisper. The `<name>` is matched against the project's
name (the filename it was uploaded under — uploads are stored under a generated
UUID, so the stored path cannot identify the media), falling back to the source
file's own basename. So uploading `long-sample.mp4` replays `long-sample.json`,
but a project renamed to something without a matching fixture fails with an error
naming both candidates it tried — it never invents an empty transcript, since
that would be indistinguishable from a silent video. Likewise, an unrecognised
`TRANSCRIBER` value is a startup error rather than a silent fallback, so a typo
cannot quietly reach the real binary.

Only needed to transcribe for real (`npm run worker`). The short path — both
land on the defaults, so no env vars needed:

```bash
# 1. install the CLI (puts `whisper-cli` on PATH, the default WHISPER_BIN)
brew install whisper-cpp

# 2. download the default model (~141 MB) to models/ggml-base.en.bin — the
#    default WHISPER_MODEL path, gitignored. WHISPER_MODELS=1 (plural) is the
#    download flag; singular WHISPER_MODEL is the model *path*.
WHISPER_MODELS=1 npm run fixtures
```

Or build from source and point the env vars at the results:

```bash
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j
sh ./models/download-ggml-model.sh base.en
export WHISPER_BIN=/path/to/whisper.cpp/build/bin/whisper-cli
export WHISPER_MODEL=/path/to/whisper.cpp/models/ggml-base.en.bin
```

Audio is resampled to 16 kHz mono WAV before whisper sees it — it accepts
nothing else. A missing binary or model fails with a message naming the env
var to set.

Once whisper is set up you can smoke-test the real binary. It is skipped by
default — `npm test` never spawns whisper — and opt-in rather than
auto-detected, so that "whisper is broken" can never be mistaken for "whisper
is absent":

```bash
WHISPER_SMOKE=1 npm test    # plus WHISPER_BIN/WHISPER_MODEL if not the defaults
```

It asserts the binary spawns, accepts our arg array, and emits JSON the parser
still reads — not any particular words, since the generated fixtures are sine
tones with no speech in them.

## Smart crop

Reframing to 9:16 / 1:1 / 16:9 tracks the subject through a `SubjectDetector`
interface (`src/lib/crop/`), so the test suite never needs TF.js or any model —
`npm test` passes with `FakeDetector`, which replays scripted boxes. The pure
`planCrop`/`cropFilter` do all the reframe math and are unit-tested with no
ffmpeg and no models.

The real detector, `HumanFaceDetector`, uses [@vladmandic/human] face detection
(TF.js, **CPU** — no GPU) with a center-weighted fallback when no face is found.
Like whisper, it is an **opt-in external dependency**: not in `package.json`, and
its models are gitignored. Only needed to run smart crop for real (`npm run
worker`) or the opt-in smoke test.

| Env var | Default | What it is |
|---|---|---|
| `HUMAN_MODELS_PATH` | `models/human` | Directory the face-detector models live in |
| `HUMAN_BACKEND` | `tensorflow` | TF.js backend (the `@tensorflow/tfjs-node` CPU backend) |

```bash
# 1. download the face models once (~2 MB; only the detector — mesh/iris/emotion
#    are disabled, so nothing else is fetched). Gitignored under models/human/.
CROP_MODELS=1 npm run fixtures

# 2. install the opt-in packages (both pulled in via a runtime dynamic import,
#    so the default install / build / test never touch them)
npm install @vladmandic/human @tensorflow/tfjs-node
```

A missing package, missing models, or a backend with no image decoder fails
loudly with a message naming exactly what to install — it never silently returns
"no subject", which `planCrop` would turn into a static center crop with no hint
anything was wrong.

Once set up you can smoke-test the real detector. It is skipped by default —
`npm test` never loads TF.js — and opt-in rather than auto-detected, so "the
detector regressed" can never be mistaken for "the detector is absent":

```bash
CROP_SMOKE=1 npm test   # plus HUMAN_MODELS_PATH if not the default
```

It asserts the backend loads, decodes a sampled frame, and returns well-formed
normalised boxes — not any particular faces, since `short-sample.mp4` is an
ffmpeg test pattern with no faces in it.

[@vladmandic/human]: https://github.com/vladmandic/human

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm run fixtures` or a job fails with `ffmpeg`/`ffprobe` **ENOENT** / `spawn ffmpeg` | FFmpeg not on PATH | Install it and reopen the shell: `brew install ffmpeg` (macOS) / `apt-get install ffmpeg` (Debian/Ubuntu). Verify with `ffmpeg -version` and `ffprobe -version`. |
| Burn-in / captions integration test **skipped** | ffmpeg built without libass (`ass` filter absent) | Optional — install an ffmpeg with libass (`brew install ffmpeg` ships it). Exports still succeed; caption burn-in is dropped and the mp4 is produced without baked captions. |
| A transcribe job fails naming `WHISPER_BIN`/`WHISPER_MODEL` | Real whisper selected but binary or model missing | `brew install whisper-cpp` and `WHISPER_MODELS=1 npm run fixtures` (see [Transcription](#transcription)); only set `WHISPER_BIN`/`WHISPER_MODEL` for non-default locations. For local dev without whisper, set `TRANSCRIBER=fake`. |
| `TRANSCRIBER` startup error `unknown transcriber` | Typo in the env var | Use `fake` or `whisper` — an unrecognised value is rejected on purpose so a typo never silently reaches the real binary. |
| A smart-crop job fails naming `@vladmandic/human` or `HUMAN_MODELS_PATH` | Real detector selected but package or models missing | `CROP_MODELS=1 npm run fixtures` to fetch the models, then `npm install @vladmandic/human @tensorflow/tfjs-node` (see [Smart crop](#smart-crop)). Both are opt-in; unit tests use `FakeDetector` and need neither. |
| `npm test` cannot find the transcript for an uploaded file | Project name doesn't match a fixture transcript | The fake transcriber replays `tests/samples/transcripts/<name>.json` by project name; upload `long-sample.mp4` / `short-sample.mp4`, or add a matching JSON. |
| `npm run test:e2e` fails to launch a browser | Playwright browser not installed | `npx playwright install chromium` once (see [End-to-end tests](#end-to-end-tests-playwright)). |
| SQLite `database is locked` under heavy concurrency | Another process holds a write lock | Transient — the worker uses `busy_timeout` and retries. Ensure only one worker per DB file, or point workers at separate `SSECLONE_DB_PATH` values. |

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
