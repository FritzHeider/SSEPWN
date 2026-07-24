import { rmSync } from "node:fs";

import { and, eq } from "drizzle-orm";

import { clips, projects, transcripts } from "../../lib/db/schema";
import { clipThumbnailPath } from "../../lib/media/derived";
import {
  mergeConfig,
  parseClipConfig,
  resolveConfig,
} from "../../lib/highlights/config";
import { audioEnergy, sceneChanges } from "../../lib/highlights/extractors";
import { fallbackCandidates, wholeVideoCandidate } from "../../lib/highlights/fallback";
import { scoreWindows, type Candidate, type ScoreWindowsOptions } from "../../lib/highlights/score";
import { selectClips } from "../../lib/highlights/select";
import { snapBoundaries } from "../../lib/highlights/snap";
import { createJobQueue } from "../../lib/jobs";
import type { TranscriptSegment } from "../../lib/transcribe/types";
import type { JobHandler, JobContext } from "./index";

// Config parsing/merging/defaults live in lib/highlights/config so the config
// API and this handler share one validator. Re-exported here because tests and
// earlier callers import them from the handler.
export {
  DEFAULT_CLIP_CONFIG,
  parseClipConfig,
  type ClipConfig,
} from "../../lib/highlights/config";

/** Longest a generated clip title may be (SPEC/Phase-04: "trimmed to 60 chars"). */
export const TITLE_MAX = 60;

/**
 * Parse a project's stored `clip_config` JSON into clean overrides. The column
 * is written by our own config API (already validated), but it is still text
 * that could be hand-edited or corrupted, so a parse failure degrades to "no
 * overrides" rather than crashing the job.
 */
function projectClipConfig(raw: string | null) {
  if (!raw) return {};
  try {
    return parseClipConfig(JSON.parse(raw));
  } catch {
    return {};
  }
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
 * the winners.
 *
 * Edge states (SPEC/Phase-11) fall out of the same select→persist tail:
 *  - **very short** (source shorter than one min-length clip): the whole video
 *    becomes a single clip — there is no room to cut anything;
 *  - **no transcript** (no audio, or audio with no detectable speech): clips
 *    come from scene cuts and energy peaks only, via `fallbackCandidates`.
 * So a project always ends with at least one clip to work with rather than an
 * empty grid.
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

    const sourcePath = project.sourceVideoPath;
    if (!sourcePath) {
      throw new Error(`Project ${project.id} ("${project.name}") has no source video to clip.`);
    }

    const [transcript] = db
      .select()
      .from(transcripts)
      .where(eq(transcripts.projectId, project.id))
      .all();
    // No transcript row means transcription skipped (no audio) or found nothing.
    // Rather than leave the project with no clips, fall back to scene/energy
    // clipping below (SPEC/Phase-11 edge states); an empty transcript row is the
    // same "no speech to score" case.
    const segments = transcript
      ? (JSON.parse(transcript.segments) as TranscriptSegment[])
      : [];

    // The project's stored config is the base; a per-run job payload (the
    // regenerate API) layers on top of it. So a saved hook list applies to every
    // regeneration, while a one-off payload can still override a single run.
    const cfg = resolveConfig(
      mergeConfig(projectClipConfig(project.clipConfig), parseClipConfig(job.payload)),
    );

    // The probe writes `duration` on ingest; it is authoritative when present.
    // A source shorter than one minimum clip can't be cut — the whole video
    // becomes a single clip, and there is no signal extraction to do.
    if (project.duration !== null && project.duration > 0 && project.duration < cfg.minLen) {
      const ids = persistClips(db, project.id, [wholeVideoCandidate(project.duration)], segments, cfg.hookPhrases);
      enqueueClipThumbnails(db, project.id, ids);
      return;
    }

    setProgress(10);
    // Both signals come from the source video via ffmpeg (the only place media
    // work is allowed). Energy is a per-second RMS series; scenes are cut
    // timestamps snapBoundaries prefers to land edges on.
    const energy = await audioEnergyFn(sourcePath);
    setProgress(45);
    const scenes = await sceneChangesFn(sourcePath);
    setProgress(65);

    // Without a stored duration (older rows) the per-second energy series is the
    // best available timeline length.
    const duration = project.duration ?? energy.length;

    let selected: Candidate[];
    if (segments.length > 0) {
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
      selected = selectClips(snapped, { n: cfg.count, minGap: cfg.minGap });
    } else if (duration > 0 && duration < cfg.minLen) {
      // No probe duration but the energy series is shorter than one clip.
      selected = [wholeVideoCandidate(duration)];
    } else {
      // No transcript: cut by scene cuts + energy peaks only.
      const candidates = fallbackCandidates(duration, energy, scenes, {
        minLen: cfg.minLen,
        maxLen: cfg.maxLen,
        windowLen: cfg.windowLen,
        step: cfg.step,
      });
      selected = selectClips(candidates, { n: cfg.count, minGap: cfg.minGap });
    }

    setProgress(85);
    const ids = persistClips(db, project.id, selected, segments, cfg.hookPhrases);
    enqueueClipThumbnails(db, project.id, ids);
  };
}

/**
 * Queue a `clip-thumbnail` job per newly-created clip. Called AFTER `persistClips`
 * commits — never inside the transaction, so a rolled-back insert can't leave a
 * thumbnail job pointing at a clip row that never existed (mirrors the
 * enqueue-after-commit rule in the transcribe/ingest handlers).
 */
function enqueueClipThumbnails(db: JobContext["db"], projectId: number, clipIds: number[]): void {
  const queue = createJobQueue(db);
  for (const clipId of clipIds) {
    queue.enqueue("clip-thumbnail", projectId, { clipId });
  }
}

/**
 * Replace a project's `candidate` clips with `selected`, in one transaction so a
 * regenerate swaps the set atomically — the clips panel never sees a half-written
 * mix of old and new. `candidate` only: manual clips are the user's, not ours.
 *
 * Returns the ids of the inserted clips so the caller can queue a thumbnail job
 * per clip AFTER this transaction commits.
 */
function persistClips(
  db: JobContext["db"],
  projectId: number,
  selected: Candidate[],
  segments: TranscriptSegment[],
  hookPhrases: readonly string[],
): number[] {
  // The candidate rows about to be replaced own poster files keyed by their id;
  // the new rows get fresh ids, so those posters would orphan on disk. Collect
  // them before the swap and unlink after it commits (best-effort).
  const replacedIds = db
    .select({ id: clips.id })
    .from(clips)
    .where(and(eq(clips.projectId, projectId), eq(clips.status, "candidate")))
    .all()
    .map((row) => row.id);

  const ids = db.transaction((tx) => {
    tx.delete(clips)
      .where(and(eq(clips.projectId, projectId), eq(clips.status, "candidate")))
      .run();
    const ids: number[] = [];
    for (const clip of selected) {
      const [inserted] = tx
        .insert(clips)
        .values({
          projectId,
          inPoint: clip.start,
          outPoint: clip.end,
          score: clip.score,
          title: autoTitle(clip, segments, hookPhrases),
          reasons: JSON.stringify(clip.reasons),
          status: "candidate",
        })
        .returning({ id: clips.id })
        .all();
      ids.push(inserted.id);
    }
    return ids;
  });

  // Drop the replaced clips' posters now that the swap is committed. Best-effort:
  // a missing file (never postered, already cleaned) is fine.
  for (const oldId of replacedIds) {
    rmSync(clipThumbnailPath(oldId), { force: true });
  }

  return ids;
}
