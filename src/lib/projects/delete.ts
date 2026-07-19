import { rmSync } from "node:fs";

import { eq, inArray } from "drizzle-orm";

import type { JobsDb } from "@/lib/jobs";
import {
  assets,
  clipEdits,
  clips,
  exports,
  jobs,
  projects,
  templates,
  transcripts,
} from "@/lib/db/schema";

/** Row counts removed per table — surfaced by the DELETE route and the test. */
export interface DeleteProjectResult {
  found: boolean;
  rows: {
    exports: number;
    clipEdits: number;
    clips: number;
    transcripts: number;
    jobs: number;
    assets: number;
    project: number;
  };
  /** Filesystem paths whose unlink was attempted (best-effort). */
  files: string[];
}

/**
 * Delete a project and everything that hangs off it, rows first then files.
 *
 * Foreign keys are ON (src/lib/db/index.ts), so the row deletes run child-first
 * inside a single transaction: exports → clip_edits → clips, then transcripts,
 * jobs and assets, then the project itself. A template may pin one of these
 * assets as its watermark (`templates.watermark_asset_id`), so those references
 * are nulled first — otherwise the asset delete trips the FK and aborts the
 * whole cascade. Templates themselves are global and are never deleted here.
 *
 * Files are unlinked only after the transaction commits: a failed row delete
 * must not leave the DB pointing at bytes we already removed. Every unlink is
 * best-effort (`force: true`) because a file may already be gone — the contract
 * the cascade test checks is "no orphan rows, no orphan files", and a missing
 * file already satisfies the second half.
 */
export function deleteProject(db: JobsDb, projectId: number): DeleteProjectResult {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return {
      found: false,
      rows: { exports: 0, clipEdits: 0, clips: 0, transcripts: 0, jobs: 0, assets: 0, project: 0 },
      files: [],
    };
  }

  const clipIds = db
    .select({ id: clips.id })
    .from(clips)
    .where(eq(clips.projectId, projectId))
    .all()
    .map((row) => row.id);

  const assetRows = db
    .select({ id: assets.id, path: assets.path, thumbnailPath: assets.thumbnailPath })
    .from(assets)
    .where(eq(assets.projectId, projectId))
    .all();
  const assetIds = assetRows.map((row) => row.id);

  // Collect every file path before the rows that name them are gone.
  const exportRows = clipIds.length
    ? db.select({ outputPath: exports.outputPath }).from(exports).where(inArray(exports.clipId, clipIds)).all()
    : [];
  const files = [
    project.sourceVideoPath,
    project.thumbnailPath,
    ...assetRows.flatMap((asset) => [asset.path, asset.thumbnailPath]),
    ...exportRows.map((row) => row.outputPath),
  ].filter((path): path is string => typeof path === "string" && path.length > 0);

  const count = (result: { changes: number }) => result.changes;
  const rows = db.transaction((tx) => {
    const exportsDeleted = clipIds.length
      ? count(tx.delete(exports).where(inArray(exports.clipId, clipIds)).run())
      : 0;
    const clipEditsDeleted = clipIds.length
      ? count(tx.delete(clipEdits).where(inArray(clipEdits.clipId, clipIds)).run())
      : 0;
    const clipsDeleted = count(tx.delete(clips).where(eq(clips.projectId, projectId)).run());
    const transcriptsDeleted = count(tx.delete(transcripts).where(eq(transcripts.projectId, projectId)).run());
    const jobsDeleted = count(tx.delete(jobs).where(eq(jobs.projectId, projectId)).run());
    if (assetIds.length) {
      // Release any watermark reference before the asset it points at vanishes.
      tx.update(templates).set({ watermarkAssetId: null }).where(inArray(templates.watermarkAssetId, assetIds)).run();
    }
    const assetsDeleted = count(tx.delete(assets).where(eq(assets.projectId, projectId)).run());
    const projectDeleted = count(tx.delete(projects).where(eq(projects.id, projectId)).run());
    return {
      exports: exportsDeleted,
      clipEdits: clipEditsDeleted,
      clips: clipsDeleted,
      transcripts: transcriptsDeleted,
      jobs: jobsDeleted,
      assets: assetsDeleted,
      project: projectDeleted,
    };
  });

  for (const path of files) {
    // Best-effort: a file that is already gone still satisfies "no orphans".
    rmSync(path, { force: true });
  }

  return { found: true, rows, files };
}
