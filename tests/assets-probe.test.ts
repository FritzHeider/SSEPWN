import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assets } from "../src/lib/db/schema";
import { probeAsset } from "../src/lib/assets/probe";
import type { AssetKind } from "../src/lib/assets/kind";
import type { Job } from "../src/lib/jobs";
import { createProbeAssetHandler, parseProbeAssetPayload } from "../src/worker/handlers/probe-asset";
import { createTestDb, type TestDb } from "./helpers/db";

const VIDEO_FIXTURE = "fixtures/broll-sample.mp4";
const IMAGE_FIXTURE = "fixtures/logo-sample.png";
const AUDIO_FIXTURE = "fixtures/sfx-sample.wav";

let testDb: TestDb;
let thumbDir: string;

beforeEach(() => {
  testDb = createTestDb();
  thumbDir = mkdtempSync(path.join(tmpdir(), "sseclone-asset-thumbs-"));
});

afterEach(() => {
  testDb.close();
  rmSync(thumbDir, { recursive: true, force: true });
});

/** Insert an asset row exactly as the upload route leaves it: no probed metadata yet. */
function seedAsset(kind: AssetKind, mime: string, assetPath: string): number {
  const [row] = testDb.db
    .insert(assets)
    .values({ type: kind, kind, mime, path: assetPath })
    .returning()
    .all();
  return row.id;
}

/** A minimal job carrying only the fields the handler reads. */
function makeJob(payload: unknown): Job {
  return {
    id: 1,
    projectId: 1,
    type: "probe-asset",
    status: "running",
    progress: 0,
    error: null,
    payload,
    attempts: 1,
    maxAttempts: 3,
    runAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("probeAsset", () => {
  it("probes a video's dimensions/duration and writes a poster thumbnail", async () => {
    const meta = await probeAsset(7, "video", VIDEO_FIXTURE, { dir: () => thumbDir });
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
    expect(meta.duration).toBeGreaterThan(7); // broll fixture is 8 s
    expect(meta.thumbnailPath).toBe(path.join(thumbDir, "asset-7.jpg"));
    expect(existsSync(meta.thumbnailPath!)).toBe(true);
    expect(statSync(meta.thumbnailPath!).size).toBeGreaterThan(0);
  });

  it("probes an image's dimensions and thumbnails it, with no duration", async () => {
    const meta = await probeAsset(9, "image", IMAGE_FIXTURE, { dir: () => thumbDir });
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.duration).toBeNull();
    expect(existsSync(meta.thumbnailPath!)).toBe(true);
  });

  it("probes audio duration only — no dimensions, no thumbnail", async () => {
    const meta = await probeAsset(11, "audio", AUDIO_FIXTURE, { dir: () => thumbDir });
    expect(meta.width).toBeNull();
    expect(meta.height).toBeNull();
    expect(meta.duration).toBeGreaterThan(1.9); // 2 s tone
    expect(meta.thumbnailPath).toBeNull();
  });
});

describe("parseProbeAssetPayload", () => {
  it("accepts a positive integer assetId", () => {
    expect(parseProbeAssetPayload({ assetId: 3 })).toEqual({ assetId: 3 });
  });

  it("rejects a missing / non-positive / non-integer assetId", () => {
    expect(() => parseProbeAssetPayload(null)).toThrow(/must be an object/);
    expect(() => parseProbeAssetPayload({})).toThrow(/positive integer assetId/);
    expect(() => parseProbeAssetPayload({ assetId: 0 })).toThrow(/positive integer assetId/);
    expect(() => parseProbeAssetPayload({ assetId: 2.5 })).toThrow(/positive integer assetId/);
  });
});

describe("probe-asset handler", () => {
  it("fills the asset row's metadata from the probe", async () => {
    const assetId = seedAsset("video", "video/mp4", VIDEO_FIXTURE);
    const handler = createProbeAssetHandler({ dir: () => thumbDir });

    await handler({ job: makeJob({ assetId }), db: testDb.db, setProgress: () => {} });

    const row = testDb.db.select().from(assets).all().find((a) => a.id === assetId)!;
    expect(row.width).toBe(640);
    expect(row.height).toBe(360);
    expect(row.duration).toBeGreaterThan(7);
    expect(row.thumbnailPath).toBe(path.join(thumbDir, `asset-${assetId}.jpg`));
    expect(existsSync(row.thumbnailPath!)).toBe(true);
  });

  it("throws when the asset does not exist", async () => {
    const handler = createProbeAssetHandler({ dir: () => thumbDir });
    await expect(
      handler({ job: makeJob({ assetId: 999 }), db: testDb.db, setProgress: () => {} }),
    ).rejects.toThrow(/Asset 999 not found/);
  });

  it("throws when the stored kind is invalid", async () => {
    const [row] = testDb.db
      .insert(assets)
      .values({ type: "broll", kind: "bogus", mime: "video/mp4", path: VIDEO_FIXTURE })
      .returning()
      .all();
    const handler = createProbeAssetHandler({ dir: () => thumbDir });
    await expect(
      handler({ job: makeJob({ assetId: row.id }), db: testDb.db, setProgress: () => {} }),
    ).rejects.toThrow(/no valid kind/);
  });
});
