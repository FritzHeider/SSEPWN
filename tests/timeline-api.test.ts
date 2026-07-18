import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { clipEdits, clips, projects } from "../src/lib/db/schema";
import { deleteSegment, splitAt } from "../src/lib/timeline/ops";
import { buildTimelineDoc, readTimelineDoc } from "../src/lib/timeline/state";
import type { TimelineDoc } from "../src/lib/timeline/types";
import { createTestDb, type TestDb } from "./helpers/db";

type ParamHandler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

let tlGET: ParamHandler;
let tlPATCH: ParamHandler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return tlGET(new Request(`http://localhost/api/clips/${id}/timeline`), ctx(id));
}

function patch(id: string, body: unknown, raw = false): Promise<Response> {
  return tlPATCH(
    new Request(`http://localhost/api/clips/${id}/timeline`, {
      method: "PATCH",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

/** Seed one project and one clip [in,out]; return the clip id + bounds. */
function seedClip(inPoint = 0, outPoint = 10): { clipId: number; inPoint: number; outPoint: number } {
  const [project] = testDb.db
    .insert(projects)
    .values({
      name: "timeline project",
      sourceVideoPath: "/tmp/x.mp4",
      duration: 30,
      width: 1280,
      height: 720,
    })
    .returning({ id: projects.id })
    .all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint, outPoint, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return { clipId: clip.id, inPoint, outPoint };
}

function storedTimeline(clipId: number): TimelineDoc | null {
  const row = testDb.db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  return row ? readTimelineDoc(JSON.parse(row.state)) : null;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: tlGET, PATCH: tlPATCH } = (await import(
    "../src/app/api/clips/[id]/timeline/route"
  )) as unknown as { GET: ParamHandler; PATCH: ParamHandler });
});

afterEach(() => {
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/clips/:id/timeline", () => {
  it("returns a fresh doc spanning the clip window when none is persisted", async () => {
    const { clipId } = seedClip(2, 8);
    const res = await get(String(clipId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timeline: TimelineDoc };
    expect(body.timeline.bounds).toEqual({ in: 2, out: 8 });
    expect(body.timeline.segments).toHaveLength(1);
    expect(body.timeline.segments[0]).toMatchObject({ sourceIn: 2, sourceOut: 8 });
    // GET must not persist the fresh doc.
    expect(storedTimeline(clipId)).toBeNull();
  });

  it("404s a missing clip and 400s a bad id", async () => {
    expect((await get("99999")).status).toBe(404);
    expect((await get("abc")).status).toBe(400);
  });
});

describe("PATCH /api/clips/:id/timeline", () => {
  it("persists an edited doc and reloads it identically", async () => {
    const { clipId, inPoint, outPoint } = seedClip(0, 10);
    // Split at 4s then drop the middle-ish second segment — a realistic edit.
    const edited = deleteSegment(splitAt(buildTimelineDoc(inPoint, outPoint), 4), "seg-2");

    const res = await patch(String(clipId), { timeline: edited });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clipId: number; timeline: TimelineDoc };
    expect(body.clipId).toBe(clipId);

    // Reload via GET returns exactly what we stored.
    const reloaded = (await (await get(String(clipId))).json()) as { timeline: TimelineDoc };
    expect(reloaded.timeline).toEqual(edited);
    expect(storedTimeline(clipId)).toEqual(edited);
  });

  it("only touches the timeline key — other edit blob data survives", async () => {
    const { clipId, inPoint, outPoint } = seedClip(0, 10);
    // Pre-seed a sibling blob under the same clip_edits row (stand-in for crop).
    const sibling = { aspectRatio: "9:16", locked: true };
    testDb.db
      .insert(clipEdits)
      .values({ clipId, state: JSON.stringify({ crop: sibling }) })
      .run();

    const doc = splitAt(buildTimelineDoc(inPoint, outPoint), 5);
    expect((await patch(String(clipId), { timeline: doc })).status).toBe(200);

    const row = testDb.db
      .select({ state: clipEdits.state })
      .from(clipEdits)
      .where(eq(clipEdits.clipId, clipId))
      .get();
    const parsed = JSON.parse(row!.state) as Record<string, unknown>;
    expect(parsed.crop).toEqual(sibling);
    expect(readTimelineDoc(parsed)).toEqual(doc);
  });

  it("rejects a doc whose bounds do not match the clip window", async () => {
    const { clipId } = seedClip(0, 10);
    const doc = buildTimelineDoc(0, 20); // wrong out bound
    const res = await patch(String(clipId), { timeline: doc });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bounds_mismatch");
  });

  it("rejects a doc with an out-of-bounds segment (invariant violation)", async () => {
    const { clipId } = seedClip(0, 10);
    const doc = buildTimelineDoc(0, 10);
    doc.segments = [{ id: "seg-1", sourceIn: 0, sourceOut: 999 }];
    const res = await patch(String(clipId), { timeline: doc });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_timeline");
  });

  it("rejects a doc with no segments and a non-JSON body", async () => {
    const { clipId } = seedClip(0, 10);
    const noSegs = await patch(String(clipId), { timeline: { version: 1, bounds: { in: 0, out: 10 }, segments: [] } });
    expect(noSegs.status).toBe(400);
    expect(((await noSegs.json()) as { code: string }).code).toBe("invalid_timeline");

    const bad = await patch(String(clipId), "{not json", true);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("invalid_body");
  });
});
