import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clips, projects } from "../src/lib/db/schema";
import { createJobQueue, type JobQueue } from "../src/lib/jobs";
import {
  createClipThumbnailHandler,
  parseClipThumbnailPayload,
} from "../src/worker/handlers/clip-thumbnail";
import { createTestDb, type TestDb } from "./helpers/db";

describe("parseClipThumbnailPayload", () => {
  it("accepts a positive integer clipId", () => {
    expect(parseClipThumbnailPayload({ clipId: 7 })).toEqual({ clipId: 7 });
  });

  it("rejects a missing or non-positive clipId", () => {
    expect(() => parseClipThumbnailPayload(null)).toThrow();
    expect(() => parseClipThumbnailPayload({})).toThrow();
    expect(() => parseClipThumbnailPayload({ clipId: 0 })).toThrow();
    expect(() => parseClipThumbnailPayload({ clipId: 1.5 })).toThrow();
  });
});

describe("clip-thumbnail handler", () => {
  let testDb: TestDb;
  let queue: JobQueue;

  beforeEach(() => {
    testDb = createTestDb();
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
  });

  afterEach(() => {
    testDb.close();
  });

  function seed(inPoint: number): { projectId: number; clipId: number } {
    const [project] = testDb.db
      .insert(projects)
      .values({ name: "p", sourceVideoPath: "fixtures/short-sample.mp4", status: "ready" })
      .returning({ id: projects.id })
      .all();
    const [clip] = testDb.db
      .insert(clips)
      .values({ projectId: project.id, inPoint, outPoint: inPoint + 4, status: "candidate" })
      .returning({ id: clips.id })
      .all();
    return { projectId: project.id, clipId: clip.id };
  }

  it("extracts a poster at the clip in-point into the derived path", async () => {
    const { projectId, clipId } = seed(12.5);
    const calls: Array<{ src: string; dest: string; atSeconds?: number; width?: number }> = [];
    const handler = createClipThumbnailHandler({
      generateThumbnailFn: async (src, dest, opts) => {
        calls.push({ src, dest, atSeconds: opts?.atSeconds, width: opts?.width });
        return dest;
      },
      pathFor: (id) => `/tmp/clip-${id}.jpg`,
    });

    await handler({
      job: queue.enqueue("clip-thumbnail", projectId, { clipId }),
      db: testDb.db,
      setProgress: () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      src: "fixtures/short-sample.mp4",
      dest: `/tmp/clip-${clipId}.jpg`,
      atSeconds: 12.5,
      width: 640,
    });
  });

  it("throws for a clip that does not exist", async () => {
    const { projectId } = seed(0);
    const handler = createClipThumbnailHandler({ generateThumbnailFn: async (_s, d) => d });
    await expect(
      handler({
        job: queue.enqueue("clip-thumbnail", projectId, { clipId: 9999 }),
        db: testDb.db,
        setProgress: () => {},
      }),
    ).rejects.toThrow(/no clip with id 9999/);
  });

  it("registers under the type the enqueue sites use", async () => {
    const { handlers } = await import("../src/worker/handlers");
    expect(typeof handlers["clip-thumbnail"]).toBe("function");
  });
});
