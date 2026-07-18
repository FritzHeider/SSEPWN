import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { clipEdits, clips, projects } from "../src/lib/db/schema";
import { FakeDetector } from "../src/lib/crop/fake";
import { buildCropState, readCropState, withCropState } from "../src/lib/crop/state";
import { aspectRatioValue, type AspectRatio, type Box } from "../src/lib/crop/types";
import { sampleFrames, type SampledFrame } from "../src/lib/ffmpeg/frames";
import { createJobQueue, type JobQueue } from "../src/lib/jobs";
import {
  createSmartCropHandler,
  parseSmartCropPayload,
  type SmartCropHandlerOptions,
} from "../src/worker/handlers/smart-crop";
import { createTestDb, type TestDb } from "./helpers/db";

const SHORT_SAMPLE = "fixtures/short-sample.mp4"; // 5s, 1280×720

/** A centered face box that slides left→right across the given fractions. */
function slidingFace(centerX: number): Box[] {
  return [{ x: centerX - 0.05, y: 0.3, w: 0.1, h: 0.2, confidence: 0.9 }];
}

describe("smart-crop handler", () => {
  let testDb: TestDb;
  let queue: JobQueue;

  beforeEach(() => {
    testDb = createTestDb();
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
  });

  afterEach(() => {
    testDb.close();
  });

  function seedProject(values: Partial<typeof projects.$inferInsert> = {}): number {
    const [row] = testDb.db
      .insert(projects)
      .values({
        name: "short-sample.mp4",
        sourceVideoPath: SHORT_SAMPLE,
        status: "ready",
        width: 1280,
        height: 720,
        duration: 5,
        ...values,
      })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  function seedClip(projectId: number, inPoint = 1, outPoint = 4): number {
    const [row] = testDb.db
      .insert(clips)
      .values({ projectId, inPoint, outPoint, status: "candidate" })
      .returning({ id: clips.id })
      .all();
    return row.id;
  }

  async function run(
    projectId: number,
    clipId: number,
    aspectRatio: AspectRatio,
    opts: SmartCropHandlerOptions,
  ) {
    const handler = createSmartCropHandler(opts);
    const enqueued = queue.enqueue("smart-crop", projectId, { clipId, aspectRatio });
    const job = queue.claimNext();
    if (!job || job.id !== enqueued.id) throw new Error("failed to claim smart-crop job");
    await handler({ job, db: testDb.db, setProgress: () => {} });
  }

  function storedCrop(clipId: number) {
    const row = testDb.db
      .select({ state: clipEdits.state })
      .from(clipEdits)
      .where(eq(clipEdits.clipId, clipId))
      .get();
    return row ? readCropState(JSON.parse(row.state)) : null;
  }

  it("samples the clip range, plans a crop, and stores keyframes at exact AR (real ffmpeg)", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId, 1, 4); // 3s window ⇒ frames at t=0,1,2
    const detector = new FakeDetector({
      frames: [slidingFace(0.2), slidingFace(0.5), slidingFace(0.8)],
      onExhausted: "last",
    });

    await run(projectId, clipId, "9:16", { detector, sampleFramesFn: sampleFrames });

    const crop = storedCrop(clipId);
    expect(crop).not.toBeNull();
    expect(crop!.aspectRatio).toBe("9:16");
    expect(crop!.srcWidth).toBe(1280);
    expect(crop!.srcHeight).toBe(720);
    expect(crop!.locked).toBe(false);
    expect(crop!.keyframes.length).toBeGreaterThanOrEqual(1);
    // Every keyframe carries the target AR within 1px and fits the source.
    for (const kf of crop!.keyframes) {
      expect(Math.abs(kf.w / kf.h - aspectRatioValue("9:16"))).toBeLessThan(0.01);
      expect(kf.x).toBeGreaterThanOrEqual(0);
      expect(kf.x + kf.w).toBeLessThanOrEqual(1280);
      expect(kf.y).toBeGreaterThanOrEqual(0);
      expect(kf.y + kf.h).toBeLessThanOrEqual(720);
    }
    // Subject slid left→right, so the window pans right: x is non-decreasing.
    for (let i = 1; i < crop!.keyframes.length; i++) {
      expect(crop!.keyframes[i].x).toBeGreaterThanOrEqual(crop!.keyframes[i - 1].x);
    }
  });

  it("passes the clip's in-point and duration to the frame sampler", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId, 2, 4.5);
    let captured: { start?: number; duration?: number } = {};
    const fakeSampler = (async (_v, _n, dir, o) => {
      captured = { start: o?.startSec, duration: o?.durationSec };
      return [{ t: 0, path: `${dir}/f.png` }] satisfies SampledFrame[];
    }) as typeof sampleFrames;
    const detector = new FakeDetector({ frames: [slidingFace(0.5)] });

    await run(projectId, clipId, "1:1", { detector, sampleFramesFn: fakeSampler });

    expect(captured.start).toBe(2);
    expect(captured.duration).toBeCloseTo(2.5, 5);
  });

  it("leaves a locked crop untouched (re-run auto cannot clobber a manual override)", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    const locked = buildCropState(
      "1:1",
      [{ t: 0, x: 999, y: 111, w: 720, h: 720 }],
      1280,
      720,
      true,
    );
    testDb.db
      .insert(clipEdits)
      .values({ clipId, state: JSON.stringify(withCropState({}, locked)) })
      .run();

    // A detector that would throw if invoked proves the job short-circuits.
    const detector = {
      detect: async () => {
        throw new Error("detector must not run on a locked crop");
      },
    };
    await run(projectId, clipId, "9:16", {
      detector,
      sampleFramesFn: (async () => {
        throw new Error("sampler must not run on a locked crop");
      }) as typeof sampleFrames,
    });

    expect(storedCrop(clipId)).toEqual(locked);
  });

  it("preserves sibling blob keys (captions) when writing crop", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    const captions = { cues: [{ text: "hi" }], style: { preset: "bold-pop" } };
    testDb.db.insert(clipEdits).values({ clipId, state: JSON.stringify({ captions }) }).run();
    const detector = new FakeDetector({ frames: [slidingFace(0.5)] });

    await run(projectId, clipId, "16:9", {
      detector,
      sampleFramesFn: (async (_v, _n, dir) =>
        [{ t: 0, path: `${dir}/f.png` }] satisfies SampledFrame[]) as typeof sampleFrames,
    });

    const row = testDb.db
      .select({ state: clipEdits.state })
      .from(clipEdits)
      .where(eq(clipEdits.clipId, clipId))
      .get();
    const blob = JSON.parse(row!.state);
    expect(blob.captions).toEqual(captions);
    expect(readCropState(blob)?.aspectRatio).toBe("16:9");
  });

  it("fails loudly when no detector is configured", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    await expect(
      run(projectId, clipId, "9:16", {
        sampleFramesFn: (async (_v, _n, dir) =>
          [{ t: 0, path: `${dir}/f.png` }] satisfies SampledFrame[]) as typeof sampleFrames,
      }),
    ).rejects.toThrow(/no SubjectDetector configured/);
  });

  it("throws when the project has no source video", async () => {
    const projectId = seedProject({ sourceVideoPath: null });
    const clipId = seedClip(projectId);
    await expect(
      run(projectId, clipId, "9:16", { detector: new FakeDetector({ frames: [] }) }),
    ).rejects.toThrow(/no source video/);
  });

  it("throws when the clip does not exist", async () => {
    const projectId = seedProject();
    await expect(
      run(projectId, 9999, "9:16", { detector: new FakeDetector({ frames: [] }) }),
    ).rejects.toThrow(/no clip with id 9999/);
  });
});

describe("parseSmartCropPayload", () => {
  it("accepts a well-formed payload and defaults sampleEverySec", () => {
    expect(parseSmartCropPayload({ clipId: 3, aspectRatio: "9:16" })).toEqual({
      clipId: 3,
      aspectRatio: "9:16",
      sampleEverySec: 1,
    });
  });

  it("honours an explicit sampleEverySec", () => {
    expect(parseSmartCropPayload({ clipId: 3, aspectRatio: "1:1", sampleEverySec: 2 }).sampleEverySec).toBe(2);
  });

  it.each([
    ["null", null],
    ["missing clipId", { aspectRatio: "9:16" }],
    ["non-integer clipId", { clipId: 1.5, aspectRatio: "9:16" }],
    ["zero clipId", { clipId: 0, aspectRatio: "9:16" }],
    ["bad aspectRatio", { clipId: 1, aspectRatio: "4:3" }],
    ["non-positive sampleEverySec", { clipId: 1, aspectRatio: "9:16", sampleEverySec: 0 }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseSmartCropPayload(raw)).toThrow();
  });
});
