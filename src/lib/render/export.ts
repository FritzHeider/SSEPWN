import path from "node:path";

import { eq } from "drizzle-orm";

import type { CaptionDoc } from "../captions/ass";
import { readCaptionDoc } from "../captions/edit";
import { readCropState } from "../crop/state";
import { assets, clipEdits, clips, projects } from "../db/schema";
import type { JobsDb } from "../jobs";
import { buildTimelineDoc, readTimelineDoc } from "../timeline/state";
import { renderPlan, type RenderPlan } from "./plan";

/**
 * Where rendered exports are written (SPEC.md § Export: `data/exports/`).
 * Overridable so tests and CI never touch the real directory — mirrors
 * `SSECLONE_ASSET_DIR` for the asset upload dir.
 */
export function resolveExportDir(): string {
  return process.env.SSECLONE_EXPORT_DIR ?? path.join("data", "exports");
}

/** Deterministic output path `<dir>/<clip>-<preset>.mp4` (SPEC.md § Export). A
 * re-export of the same clip+preset overwrites in place, so history stays one
 * file per (clip, preset). */
export function exportOutputPath(dir: string, clipId: number, presetId: string): string {
  return path.join(dir, `${clipId}-${presetId}.mp4`);
}

/** The pieces `executePlan` needs, compiled from a clip's persisted edit state. */
export interface CompiledClipRender {
  plan: RenderPlan;
  /** Filesystem path for every media input id in `plan.inputs`. */
  inputPaths: Record<string, string>;
  /** The clip's caption doc, so the handler can render an ASS file for the
   * `captions` node; null when the clip has no captions. */
  captions: CaptionDoc | null;
}

/** Read the clip's parsed `clip_edits.state` blob (or `{}` when none/corrupt).
 * Mirrors the per-route helper — kept private so the compiler is self-contained. */
function readState(db: JobsDb, clipId: number): Record<string, unknown> {
  const row = db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.state);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to empty */
  }
  return {};
}

/**
 * Compile one clip's persisted edit into everything {@link executePlan} needs:
 * the {@link RenderPlan}, a path for every media input it references, and the
 * caption doc (so the handler can render an ASS file). Deterministic and DB-only
 * — no ffmpeg, no file IO — so it is unit-testable against a seeded database.
 *
 * A clip with no saved timeline compiles the whole source window (its in/out
 * points), matching what the editor shows before the first edit. Throws with a
 * clear message when a referenced media file is missing from the DB, rather than
 * letting an empty input path surface deep inside an ffmpeg filtergraph.
 */
export function compileClipRender(db: JobsDb, clipId: number): CompiledClipRender {
  const clip = db
    .select({
      id: clips.id,
      projectId: clips.projectId,
      inPoint: clips.inPoint,
      outPoint: clips.outPoint,
    })
    .from(clips)
    .where(eq(clips.id, clipId))
    .get();
  if (!clip) throw new Error(`Export compile: no clip with id ${clipId}`);

  const project = db
    .select({ sourceVideoPath: projects.sourceVideoPath })
    .from(projects)
    .where(eq(projects.id, clip.projectId))
    .get();
  const mainPath = project?.sourceVideoPath;
  if (!mainPath) {
    throw new Error(`Export compile: project ${clip.projectId} has no source video`);
  }

  const state = readState(db, clipId);
  const timeline = readTimelineDoc(state) ?? buildTimelineDoc(clip.inPoint, clip.outPoint);
  const crop = readCropState(state);
  const captions = readCaptionDoc(state);

  const plan = renderPlan({ timeline, crop, captions });

  const inputPaths: Record<string, string> = {};
  for (const input of plan.inputs) {
    if (input.assetId === null) {
      inputPaths[input.id] = mainPath;
      continue;
    }
    const asset = db
      .select({ path: assets.path })
      .from(assets)
      .where(eq(assets.id, input.assetId))
      .get();
    if (!asset?.path) {
      throw new Error(`Export compile: asset ${input.assetId} (input ${input.id}) has no file`);
    }
    inputPaths[input.id] = asset.path;
  }

  return { plan, inputPaths, captions };
}
