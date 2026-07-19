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
| `npm run test:e2e` | Playwright end-to-end (timeline editor) |

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

Only needed to transcribe for real (`npm run worker`):

```bash
# 1. build whisper.cpp (see https://github.com/ggerganov/whisper.cpp)
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j

# 2. download a model — base.en is a good speed/quality default
sh ./models/download-ggml-model.sh base.en

# 3. point Sseclone at both (models/ and *.bin are gitignored)
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
