import { eq } from "drizzle-orm";

import { assets } from "../../lib/db/schema";
import { isAssetKind, type AssetKind } from "../../lib/assets/kind";
import { probeAsset, type ProbeAssetOptions } from "../../lib/assets/probe";
import { updateAssetMetadata } from "../../lib/assets/queries";
import type { JobContext, JobHandler } from "./index";

/** How a probe-asset job is addressed: one asset row to fill in metadata for. */
export interface ProbeAssetPayload {
  assetId: number;
}

/**
 * Validate a probe-asset payload at the boundary. Written by our own
 * `/api/assets` route (already validated) but still free-form JSON out of the
 * `jobs` table, so a bad shape fails the job with a clear message.
 */
export function parseProbeAssetPayload(raw: unknown): ProbeAssetPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("probe-asset payload must be an object with { assetId }");
  }
  const obj = raw as Record<string, unknown>;
  if (!Number.isInteger(obj.assetId) || (obj.assetId as number) <= 0) {
    throw new Error(`probe-asset payload needs a positive integer assetId, got ${obj.assetId}`);
  }
  return { assetId: obj.assetId as number };
}

export type ProbeAssetHandlerOptions = ProbeAssetOptions;

/**
 * `probe-asset` — read an uploaded asset's real dimensions/duration and, for
 * video and image kinds, render a poster thumbnail (SPEC.md § Feature checklist
 * 7: "thumbnails for video/image assets").
 *
 * The asset's `kind` was fixed at upload from the agreed MIME+extension, so this
 * trusts it rather than re-sniffing; a stored kind that is somehow invalid fails
 * the job loudly instead of silently probing the wrong way. Probe/thumbnail work
 * lives here (not in the request handler) per the global "no media work in a
 * Next.js request" constraint.
 */
export function createProbeAssetHandler(options: ProbeAssetHandlerOptions = {}): JobHandler {
  return async function probeAssetJob({ job, db, setProgress }: JobContext): Promise<void> {
    const { assetId } = parseProbeAssetPayload(job.payload);

    const [asset] = db.select().from(assets).where(eq(assets.id, assetId)).all();
    if (!asset) {
      throw new Error(`Asset ${assetId} not found for probe-asset job ${job.id}`);
    }
    if (!isAssetKind(asset.kind)) {
      throw new Error(`Asset ${assetId} has no valid kind to probe (got ${String(asset.kind)})`);
    }

    setProgress(20);
    const metadata = await probeAsset(assetId, asset.kind as AssetKind, asset.path, options);

    setProgress(90);
    updateAssetMetadata(assetId, metadata, db);
  };
}
