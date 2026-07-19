import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";

import { toAss } from "../../lib/captions/ass";
import { exports } from "../../lib/db/schema";
import { resolvePlatformPreset } from "../../lib/presets";
import {
  executePlan,
  type RenderQuality,
} from "../../lib/render/execute";
import {
  compileClipRender,
  exportOutputPath,
  resolveExportDir,
} from "../../lib/render/export";
import type { JobContext, JobHandler } from "./index";

/** How an export job is addressed: the `exports` row to render, at what quality.
 * The row already carries the clip + platform preset; quality is an encode knob
 * (draft/final) that is not persisted on the row, so it travels in the payload. */
export interface ExportPayload {
  exportId: number;
  quality: RenderQuality;
}

const QUALITIES: readonly RenderQuality[] = ["draft", "final"];

function isRenderQuality(value: unknown): value is RenderQuality {
  return typeof value === "string" && (QUALITIES as readonly string[]).includes(value);
}

/**
 * Validate an export payload at the boundary. Written by our own `/api/clips/:id/
 * export` route, but still free-form JSON out of the `jobs` table, so a bad shape
 * fails the job with a clear message. Quality defaults to `final` (draft is the
 * opt-in "quick preview render").
 */
export function parseExportPayload(raw: unknown): ExportPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("export payload must be an object with { exportId }");
  }
  const obj = raw as Record<string, unknown>;
  if (!Number.isInteger(obj.exportId) || (obj.exportId as number) <= 0) {
    throw new Error(`export payload needs a positive integer exportId, got ${obj.exportId}`);
  }
  const quality = obj.quality === undefined ? "final" : obj.quality;
  if (!isRenderQuality(quality)) {
    throw new Error(`export payload quality must be draft|final, got ${quality}`);
  }
  return { exportId: obj.exportId as number, quality };
}

/**
 * `export` — render one clip's edited timeline to a delivery MP4 (SPEC.md §
 * Export pipeline, Phase 10). Compiles the clip's persisted edit into a render
 * plan, resolves input files, burns captions when present, and runs ffmpeg via
 * {@link executePlan}, streaming progress onto the job. The output lands at
 * `data/exports/<clip>-<preset>.mp4` and the `exports` row tracks status.
 *
 * All media work lives here (not in a request handler) per the global "no media
 * work in a Next.js request" constraint. On ffmpeg failure the `exports` row is
 * marked `failed` with the error, and the throw propagates so the worker records
 * the job error and applies retry/backoff — a retry after the cause is fixed
 * (e.g. a restored source file) flips the row back through `running` to `done`.
 */
export function createExportHandler(): JobHandler {
  return async function exportJob({ job, db, setProgress }: JobContext): Promise<void> {
    const { exportId, quality } = parseExportPayload(job.payload);

    const [row] = db.select().from(exports).where(eq(exports.id, exportId)).all();
    if (!row) {
      throw new Error(`Export ${exportId} not found for export job ${job.id}`);
    }

    db.update(exports)
      .set({ status: "running", jobId: job.id, error: null })
      .where(eq(exports.id, exportId))
      .run();

    const preset = resolvePlatformPreset(row.preset);
    const { plan, inputPaths, captions } = compileClipRender(db, row.clipId);

    const dir = resolveExportDir();
    mkdirSync(dir, { recursive: true });
    const outputPath = exportOutputPath(dir, row.clipId, row.preset);

    // Captions burn from an ASS file rendered at the preset's resolution. The
    // plan carries only the cue count + style name, so the doc must be written
    // to disk here; a scratch dir keeps it out of the delivery folder.
    const hasCaptions = plan.nodes.some((n) => n.kind === "captions");
    let assDir: string | null = null;
    let captionsAssPath: string | undefined;
    if (hasCaptions && captions) {
      assDir = mkdtempSync(path.join(tmpdir(), "sseclone-export-ass-"));
      captionsAssPath = path.join(assDir, `${row.clipId}.ass`);
      writeFileSync(captionsAssPath, toAss(captions, preset.width, preset.height));
    }

    try {
      await executePlan({
        plan,
        inputPaths,
        outputPath,
        preset,
        quality,
        captionsAssPath,
        onProgress: (pct) => setProgress(pct),
      });
      db.update(exports)
        .set({ status: "done", outputPath, error: null })
        .where(eq(exports.id, exportId))
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.update(exports).set({ status: "failed", error: message }).where(eq(exports.id, exportId)).run();
      throw error;
    } finally {
      if (assDir) rmSync(assDir, { recursive: true, force: true });
    }
  };
}
