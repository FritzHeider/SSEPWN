# Sseclone — Ralph prompt pack

Prompt set for building an AI video clipping tool (Ssemble clone: long video
→ AI highlights → auto captions → smart crop → B-roll/transitions/SFX/CTA →
platform exports) with **ralph-orchestrator** (mikeyobrien/ralph-orchestrator,
hat-based CLI).

## What's in here

| File | Role |
|---|---|
| `ralph.yml` | Ralph config: backend, limits, guardrails, scratchpad, memories |
| `PROMPT.md` | Masterprompt — orchestrates all phases in one long loop |
| `SPEC.md` | Product + stack spec; single source of truth read every iteration |
| `prompts/phase-01-scaffold.md` | Repo skeleton, gates, generated test fixtures |
| `prompts/phase-02-ingest-jobs.md` | Upload, SQLite job queue, worker |
| `prompts/phase-03-transcription.md` | whisper.cpp behind an interface + fake for tests |
| `prompts/phase-04-highlights.md` | Highlight scoring + auto-clipping (the core AI) |
| `prompts/phase-05-captions.md` | Styled editable captions + ASS burn-in |
| `prompts/phase-06-smart-crop.md` | Subject-tracked reframe 9:16/1:1/16:9 |
| `prompts/phase-07-timeline-editor.md` | Timeline editor UI over a pure state model |
| `prompts/phase-08-enhancements.md` | B-roll, transitions, SFX, CTA + renderPlan compiler |
| `prompts/phase-09-templates.md` | Templates + platform presets |
| `prompts/phase-10-export.md` | Real ffmpeg rendering of the plan + export UX |
| `prompts/phase-11-hardening.md` | Dashboard, full-journey e2e, hardening |

## Completion signals (how the loop stops)

- **Phase run**: each phase prompt tells the agent to end its output with the
  single line `LOOP_COMPLETE` only after every acceptance criterion passed in
  that same iteration. That matches `event_loop.completion_promise` in
  `ralph.yml`.
- **Masterprompt run**: `PROMPT.md` uses a different promise,
  `ALL_PHASES_COMPLETE`, passed via `--completion-promise`. This way a phase
  finishing mid-run can't stop the whole build early.
- The `- [x] PHASE_COMPLETE` checkboxes inside the files are disk state for
  fresh-context iterations, not the stop signal.

## Setup

```bash
mkdir sseclone && cd sseclone
git init                       # git is Ralph's memory — required
cp -r /path/to/this-pack/{ralph.yml,PROMPT.md,SPEC.md,prompts} .
git add -A && git commit -m "ralph prompt pack"
ralph init --backend claude    # if you don't already have ralph configured;
                               # keep this pack's ralph.yml if init offers to overwrite
ralph preflight                # validation check before first run
```

Machine prerequisites the loop expects: node 20+, ffmpeg/ffprobe on PATH,
sqlite3 CLI, Claude Code (the backend). Optional (only for smoke tests):
whisper.cpp binary + model.

## Recommended: run phase-by-phase

Tighter control, and you review the repo between phases:

```bash
ralph run -P prompts/phase-01-scaffold.md --max-iterations 15 --dry-run  # preview first
ralph run -P prompts/phase-01-scaffold.md --max-iterations 15
# review the repo, then:
ralph run -P prompts/phase-02-ingest-jobs.md --max-iterations 20
# ... continue through phase-11
```

Use `--continue` to resume a run from existing state after an interruption,
and `-a/--autonomous` for headless runs.

Suggested iteration budgets (tune after phase 01; `max_runtime_seconds` in
ralph.yml gives every run a 4 h hard stop):

| Phase | --max-iterations |
|---|---|
| 01 scaffold | 15 |
| 02 ingest/jobs | 20 |
| 03 transcription | 15 |
| 04 highlights | 25 |
| 05 captions | 20 |
| 06 smart crop | 25 |
| 07 timeline UI | 30 |
| 08 enhancements | 35 |
| 09 templates | 15 |
| 10 export | 35 |
| 11 hardening | 20 |

## Alternative: one long run on the masterprompt

```bash
ralph run -P PROMPT.md --max-iterations 100 \
  --completion-promise "ALL_PHASES_COMPLETE"
```

The masterprompt walks the phase files in order, tracking progress via its
Status checklist, and outputs `ALL_PHASES_COMPLETE` only when all 11 phases
are done and every gate passes. Use `--dry-run` first.

## Monitoring & steering

- `ralph web` — monitoring dashboard; per-iteration state lives under `.ralph/`
  (scratchpad at `.ralph/agent/scratchpad.md`)
- If the loop stalls or misbehaves, don't rewrite the prompt — append a
  short targeted "sign" to the active phase file (or a guardrail to
  `ralph.yml`), then rerun with `--continue`, e.g.:
  - `- Sign: stop re-installing dependencies every iteration; check node_modules first.`
  - `- Sign: the xfade filter needs both inputs at the same fps — normalize first.`
- Loop detection kills runs whose output is ≥90% similar to recent
  iterations. The prompts (and a guardrail) already require
  iteration-specific diff summaries; verify the agent is complying if a run
  dies with "loop detected".
- Between phases, skim `git log` and run `npm run check` yourself before
  starting the next phase.
- Optional human-in-the-loop mid-run: `ralph bot onboard --telegram` (RObot),
  then enable it in `ralph.yml`.

## Design notes (why the prompts look this way)

- Every acceptance criterion is a runnable command — vague criteria are the
  #1 cause of runaway loops.
- All AI components (transcriber, subject detector, highlight scorer) sit
  behind interfaces with deterministic fakes, so `npm test` passes offline
  with no models installed. Real whisper/TF.js paths are smoke-tested behind
  env flags.
- Test media is generated by script (ffmpeg testsrc/sine), never committed.
- Phase 08 compiles every visual feature into a pure `renderPlan`; Phase 10
  executes it. This splits "what to render" (cheap to unit test) from
  "ffmpeg wrangling" (expensive integration tests) so the loop converges.
- "Tests are the contract — never weaken them" appears in the prompts AND as
  a ralph.yml guardrail because loops sometimes satisfy gates by deleting
  the gates.
- Distinct completion promises for phase runs (`LOOP_COMPLETE`) vs the
  masterprompt (`ALL_PHASES_COMPLETE`) prevent a single finished phase from
  terminating a full-build run.
# SSEPWN
