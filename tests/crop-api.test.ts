import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FakeDetector } from "../src/lib/crop/fake";
import { readCropState } from "../src/lib/crop/state";
import { clipEdits, clips, jobs, projects } from "../src/lib/db/schema";
import { createJobQueue } from "../src/lib/jobs";
import { createSmartCropHandler } from "../src/worker/handlers/smart-crop";
import { createTestDb, type TestDb } from "./helpers/db";

type ParamHandler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

let cropPOST: ParamHandler;
let cropPATCH: ParamHandler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function post(id: string, body: unknown, raw = false): Promise<Response> {
  return cropPOST(
    new Request(`http://localhost/api/clips/${id}/crop`, {
      method: "POST",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function patch(id: string, body: unknown, raw = false): Promise<Response> {
  return cropPATCH(
    new Request(`http://localhost/api/clips/${id}/crop`, {
      method: "PATCH",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

/** Seed one project (with ingested dims) and one clip; return the clip id. */
function seedClip(dims: { width?: number | null; height?: number | null } = {}): {
  clipId: number;
  projectId: number;
} {
  const [project] = testDb.db
    .insert(projects)
    .values({
      name: "crop project",
      sourceVideoPath: "/tmp/x.mp4",
      duration: 10,
      width: dims.width === undefined ? 1280 : dims.width,
      height: dims.height === undefined ? 720 : dims.height,
    })
    .returning({ id: projects.id })
    .all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return { clipId: clip.id, projectId: project.id };
}

function storedCrop(clipId: number) {
  const row = testDb.db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  return row ? readCropState(JSON.parse(row.state)) : null;
}

const KF = { t: 1, x: 300, y: 0, w: 405, h: 720 };

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ POST: cropPOST, PATCH: cropPATCH } = (await import(
    "../src/app/api/clips/[id]/crop/route"
  )) as unknown as { POST: ParamHandler; PATCH: ParamHandler });
});

afterEach(() => {
  // Clear per-test rows so ids/state don't bleed across cases.
  testDb.db.delete(jobs).run();
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("POST /api/clips/:id/crop", () => {
  it("enqueues a smart-crop job on the clip's project (202)", async () => {
    const { clipId, projectId } = seedClip();
    const res = await post(String(clipId), { aspectRatio: "9:16" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: { id: number; type: string; projectId: number } };
    expect(body.job.type).toBe("smart-crop");
    expect(body.job.projectId).toBe(projectId);

    // The queued job carries a valid smart-crop payload.
    const row = testDb.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, body.job.id)).get();
    expect(JSON.parse(row!.payload!)).toEqual({ clipId, aspectRatio: "9:16" });
  });

  it("passes an optional sampleEverySec into the payload", async () => {
    const { clipId } = seedClip();
    const res = await post(String(clipId), { aspectRatio: "1:1", sampleEverySec: 2 });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: { id: number } };
    const row = testDb.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, body.job.id)).get();
    expect(JSON.parse(row!.payload!)).toEqual({ clipId, aspectRatio: "1:1", sampleEverySec: 2 });
  });

  it("does no work in the handler beyond enqueuing (no crop written yet)", async () => {
    const { clipId } = seedClip();
    await post(String(clipId), { aspectRatio: "9:16" });
    expect(storedCrop(clipId)).toBeNull();
  });

  it.each([
    ["not-an-int id", "abc", { aspectRatio: "9:16" }, 400],
    ["missing aspectRatio", null, {}, 400],
    ["unknown aspectRatio", null, { aspectRatio: "4:3" }, 400],
    ["non-positive sampleEverySec", null, { aspectRatio: "9:16", sampleEverySec: 0 }, 400],
  ])("rejects %s", async (_label, badId, body, status) => {
    const { clipId } = seedClip();
    const id = badId ?? String(clipId);
    const res = await post(id, body);
    expect(res.status).toBe(status);
  });

  it("404s for an unknown clip", async () => {
    const res = await post("999999", { aspectRatio: "9:16" });
    expect(res.status).toBe(404);
  });

  it("400s on a non-JSON body", async () => {
    const { clipId } = seedClip();
    const res = await post(String(clipId), "{not json", true);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/clips/:id/crop", () => {
  it("writes a locked manual keyframe on a clip with no auto crop yet", async () => {
    const { clipId } = seedClip();
    const res = await patch(String(clipId), { keyframe: KF, aspectRatio: "9:16" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clipId: number; crop: ReturnType<typeof readCropState> };
    expect(body.crop!.locked).toBe(true);
    expect(body.crop!.keyframes).toEqual([KF]);

    const crop = storedCrop(clipId);
    expect(crop!.locked).toBe(true);
    expect(crop!.aspectRatio).toBe("9:16");
    expect(crop!.srcWidth).toBe(1280);
    expect(crop!.srcHeight).toBe(720);
  });

  it("preserves sibling keys (captions) when writing the crop override", async () => {
    const { clipId } = seedClip();
    testDb.db
      .insert(clipEdits)
      .values({ clipId, state: JSON.stringify({ captions: { cues: [1, 2] } }) })
      .run();
    const res = await patch(String(clipId), { keyframe: KF, aspectRatio: "9:16" });
    expect(res.status).toBe(200);
    const row = testDb.db.select({ state: clipEdits.state }).from(clipEdits).where(eq(clipEdits.clipId, clipId)).get();
    const parsed = JSON.parse(row!.state) as { captions: unknown; crop: unknown };
    expect(parsed.captions).toEqual({ cues: [1, 2] });
    expect(readCropState(parsed)!.locked).toBe(true);
  });

  it("survives a re-run of the auto smart-crop job (locked wins)", async () => {
    const { clipId, projectId } = seedClip();
    // Lock a manual override at t=1.
    await patch(String(clipId), { keyframe: KF, aspectRatio: "9:16" });
    const before = storedCrop(clipId);
    expect(before!.locked).toBe(true);

    // Re-run auto: enqueue + run the real handler (fake sampler/detector so no
    // ffmpeg). The locked crop must be left exactly as the user set it.
    const queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
    const handler = createSmartCropHandler({
      detector: new FakeDetector({ frames: [], onExhausted: "empty" }),
      sampleFramesFn: async () => [{ t: 0, path: "/nope.png" }],
    });
    queue.enqueue("smart-crop", projectId, { clipId, aspectRatio: "16:9" });
    const job = queue.claimNext();
    await handler({ job: job!, db: testDb.db, setProgress: () => {} });

    const after = storedCrop(clipId);
    expect(after).toEqual(before); // unchanged: still 9:16, single manual keyframe, locked
  });

  it("400s a first override that omits the required aspectRatio", async () => {
    const { clipId } = seedClip();
    const res = await patch(String(clipId), { keyframe: KF });
    expect(res.status).toBe(400);
  });

  it("400s when the project has no ingested dimensions and there is no crop", async () => {
    const { clipId } = seedClip({ width: null, height: null });
    const res = await patch(String(clipId), { keyframe: KF, aspectRatio: "9:16" });
    expect(res.status).toBe(400);
  });

  it.each([
    ["missing keyframe", { aspectRatio: "9:16" }],
    ["malformed keyframe", { keyframe: { t: 0, x: 0 } }],
  ])("400s a %s override body", async (_label, body) => {
    const { clipId } = seedClip();
    const res = await patch(String(clipId), body);
    expect(res.status).toBe(400);
  });

  it("404s for an unknown clip", async () => {
    const res = await patch("999999", { keyframe: KF, aspectRatio: "9:16" });
    expect(res.status).toBe(404);
  });
});
