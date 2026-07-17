import { and, eq } from "drizzle-orm";

import { clips, projects, transcripts } from "../../lib/db/schema";
import { audioEnergy, sceneChanges } from "../../lib/highlights/extractors";
import {
  DEFAULT_HOOK_PHRASES,
  scoreWindows,
  type Candidate,
  type ScoreWindowsOptions,
  type SignalName,
} from "../../lib/highlights/score";
import { selectClips } from "../../lib/highlights/select";
import { snapBoundaries } from "../../lib/highlights/snap";
import type { TranscriptSegment } from "../../lib/transcribe/types";
import type { JobHandler, JobContext } from "./index";

/** Longest a generated clip title may be (SPEC/Phase-04: "trimmed to 60 chars"). */
export const TITLE_MAX = 60;

/**
 * Tuning that drives one generate-clips run. Every field is optional so a job
 * payload (the regenerate API) can override just the knobs it cares about and
 * inherit the rest — which is what makes clip generation "config-live": change
 * `hookPhrases` and a different moment ranks first.
 */
export interface ClipConfig {
  /** Shortest clip, seconds (SPEC: 15–90). */
  minLen?: number;
  /** Longest clip, seconds. */
  maxLen?: number;
  /** Sliding-window length the scan uses, seconds. */
  windowLen?: number;
  /** Window step, seconds. */
  step?: number;
  /** Max clips to keep (SPEC: 5–10). */
  count?: number;
  /** Minimum seconds between two kept clips (SPEC: ≥5). */
  minGap?: number;
  /** Hook phrases that fire the hook signal. */
  hookPhrases?: string[];
  /** Per-signal weight overrides. */
  weights?: Partial<Record<SignalName, number>>;
}

/** Config defaults — the neutral run when a project has no overrides yet. */
export const DEFAULT_CLIP_CONFIG: Required<
  Pick<ClipConfig, "minLen" | "maxLen" | "windowLen" | "step" | "count" | "minGap">
> = {
  minLen: 15,
  maxLen: 90,
  windowLen: 30,
  step: 5,
  count: 5,
  minGap: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a {@link ClipConfig} out of an untrusted job payload, keeping only
 * well-typed fields. A payload is data crossing a boundary (SPEC: validate at
 * boundaries), so a stray `minLen: "20"` is dropped rather than smuggled into
 * the scoring arithmetic where it would surface as a silent NaN.
 */
export function parseClipConfig(payload: unknown): ClipConfig {
  if (!isRecord(payload)) return {};
  const config: ClipConfig = {};

  for (const key of ["minLen", "maxLen", "windowLen", "step", "count", "minGap"] as const) {
    const value = num(payload[key]);
    if (value !== undefined) config[key] = value;
  }

  if (Array.isArray(payload.hookPhrases)) {
    const phrases = payload.hookPhrases.filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    if (phrases.length > 0) config.hookPhrases = phrases;
  }

  if (isRecord(payload.weights)) {
    const weights: Partial<Record<SignalName, number>> = {};
    for (const name of ["energy", "speechDensity", "hook", "emphasis", "laughter"] as const) {
      const value = num(payload.weights[name]);
      if (value !== undefined) weights[name] = value;
    }
    if (Object.keys(weights).length > 0) config.weights = weights;
  }

  return config;
}

/** Merge parsed overrides over the defaults into a fully-resolved config. */
function resolveConfig(config: ClipConfig) {
  return {
    minLen: config.minLen ?? DEFAULT_CLIP_CONFIG.minLen,
    maxLen: config.maxLen ?? DEFAULT_CLIP_CONFIG.maxLen,
    windowLen: config.windowLen ?? DEFAULT_CLIP_CONFIG.windowLen,
    step: config.step ?? DEFAULT_CLIP_CONFIG.step,
    count: config.count ?? DEFAULT_CLIP_CONFIG.count,
    minGap: config.minGap ?? DEFAULT_CLIP_CONFIG.minGap,
    hookPhrases: config.hookPhrases ?? [...DEFAULT_HOOK_PHRASES],
    weights: config.weights,
  };
}

/** Cap a title at {@link TITLE_MAX} chars, marking truncation with an ellipsis. */
function trimTitle(text: string): string {
  const clean = text.trim();
  if (clean.length <= TITLE_MAX) return clean;
  return `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Auto title for a clip: the first hook sentence inside its range, trimmed to
 * 60 chars (SPEC/Phase-04). A "hook sentence" is a transcript segment whose text
 * contains one of the configured hook phrases — the same phrases that scored the
 * clip, so the title names why the clip was chosen. Falls back to the first
 * spoken segment in range, and finally to the top reason, so a clip is never
 * left untitled.
 */
export function autoTitle(
  clip: Candidate,
  transcript: TranscriptSegment[],
  hookPhrases: readonly string[],
): string {
  const overlapping = transcript
    .filter((s) => s.start < clip.end && s.end > clip.start)
    .sort((a, b) => a.start - b.start);

  const phrases = hookPhrases.map((p) => p.toLowerCase());
  const hookSentence = overlapping.find((s) => {
    const lower = s.text.toLowerCase();
    return phrases.some((p) => lower.includes(p));
  });
  if (hookSentence) return trimTitle(hookSentence.text);

  const firstSpoken = overlapping.find((s) => s.text.trim().length > 0);
  if (firstSpoken) return trimTitle(firstSpoken.text);

  return trimTitle(clip.reasons[0] ?? "Clip");
}

export interface GenerateClipsHandlerOptions {
  /** Injected in tests; defaults to the real ffmpeg-backed extractors. */
  audioEnergyFn?: (path: string) => Promise<number[]>;
  sceneChangesFn?: (path: string) => Promise<number[]>;
}

/**
 * `generate-clips` — turn a transcribed project into ranked candidate clips
 * (SPEC.md § Feature checklist 3, Phase 04). Enqueued by the transcribe handler
 * once a transcript exists, and re-run by the regenerate API with an override
 * payload.
 *
 * The whole scoring core is pure (`src/lib/highlights`); this handler is only
 * the wiring: pull the transcript from the db, extract the two ffmpeg-derived
 * signals (RMS energy, scene changes), run score → snap → select, and persist
 * the winners. A project with no transcript (no audio, or nothing detected) has
 * nothing to clip, so the handler returns cleanly rather than failing — clips
 * are additive, exactly like the transcript that feeds them.
 *
 * Regeneration replaces only `candidate` rows, so manually-added clips survive.
 */
export function createGenerateClipsHandler(
  options: GenerateClipsHandlerOptions = {},
): JobHandler {
  const audioEnergyFn = options.audioEnergyFn ?? audioEnergy;
  const sceneChangesFn = options.sceneChangesFn ?? sceneChanges;

  return async function generateClips({ job, db, setProgress }: JobContext): Promise<void> {
    const [project] = db.select().from(projects).where(eq(projects.id, job.projectId)).all();
    if (!project) {
      throw new Error(`Project ${job.projectId} not found for generate-clips job ${job.id}`);
    }

    const [transcript] = db
      .select()
      .from(transcripts)
      .where(eq(transcripts.projectId, project.id))
      .all();
    // No transcript row means transcription skipped (no audio) or has not run.
    // There is nothing to score, and clips are additive, so leave the project
    // as-is rather than failing the job.
    if (!transcript) return;

    const segments = JSON.parse(transcript.segments) as TranscriptSegment[];
    if (segments.length === 0) return;

    const sourcePath = project.sourceVideoPath;
    if (!sourcePath) {
      throw new Error(`Project ${project.id} ("${project.name}") has no source video to clip.`);
    }

    const cfg = resolveConfig(parseClipConfig(job.payload));

    setProgress(10);
    // Both signals come from the source video via ffmpeg (the only place media
    // work is allowed). Energy is a per-second RMS series; scenes are cut
    // timestamps snapBoundaries prefers to land edges on.
    const energy = await audioEnergyFn(sourcePath);
    setProgress(45);
    const scenes = await sceneChangesFn(sourcePath);
    setProgress(65);

    const scoreOptions: ScoreWindowsOptions = {
      minLen: cfg.minLen,
      maxLen: cfg.maxLen,
      windowLen: cfg.windowLen,
      step: cfg.step,
      hookPhrases: cfg.hookPhrases,
      weights: cfg.weights,
    };

    const candidates = scoreWindows(segments, energy, scoreOptions);
    const snapped = candidates.map((c) =>
      snapBoundaries(c, segments, scenes, { minLen: cfg.minLen, maxLen: cfg.maxLen }),
    );
    const selected = selectClips(snapped, { n: cfg.count, minGap: cfg.minGap });

    setProgress(85);
    // Delete-then-insert in one transaction so a regenerate replaces the old
    // candidate set atomically — the clips panel never sees a half-written mix
    // of old and new. `candidate` only: manual clips are the user's, not ours.
    db.transaction((tx) => {
      tx.delete(clips)
        .where(and(eq(clips.projectId, project.id), eq(clips.status, "candidate")))
        .run();
      for (const clip of selected) {
        tx.insert(clips)
          .values({
            projectId: project.id,
            inPoint: clip.start,
            outPoint: clip.end,
            score: clip.score,
            title: autoTitle(clip, segments, cfg.hookPhrases),
            reasons: JSON.stringify(clip.reasons),
            status: "candidate",
          })
          .run();
      }
    });
  };
}
