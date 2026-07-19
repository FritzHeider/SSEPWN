import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { clipEdits, clips, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let GET: Handler;
let PUT: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/clips/${id}/preset`), ctx(id));
}

function put(id: string, body: unknown, raw = false): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/clips/${id}/preset`, {
      method: "PUT",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

/** Seed one project (optionally with a default preset) + one clip. */
function seedClip(projectPreset?: string): { clipId: number; projectId: number } {
  const [project] = testDb.db
    .insert(projects)
    .values({ name: "clip preset project", platformPreset: projectPreset ?? null })
    .returning({ id: projects.id })
    .all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return { clipId: clip.id, projectId: project.id };
}

function storedState(clipId: number): Record<string, unknown> | null {
  const row = testDb.db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  return row ? (JSON.parse(row.state) as Record<string, unknown>) : null;
}

interface ClipPresetBody {
  clipId: number;
  platformPreset: string | null;
  projectPreset: string | null;
  effective: { id: string };
  source: "clip" | "project" | "default";
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET, PUT } = (await import("../src/app/api/clips/[id]/preset/route")) as unknown as {
    GET: Handler;
    PUT: Handler;
  });
});

afterEach(() => {
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/clips/:id/preset", () => {
  it("inherits the project default (source project) when the clip has no override", async () => {
    const { clipId } = seedClip("youtube-shorts");
    const body = (await (await get(String(clipId))).json()) as ClipPresetBody;
    expect(body.platformPreset).toBeNull();
    expect(body.projectPreset).toBe("youtube-shorts");
    expect(body.effective.id).toBe("youtube-shorts");
    expect(body.source).toBe("project");
  });

  it("falls back to the product default (source default) when neither is set", async () => {
    const { clipId } = seedClip();
    const body = (await (await get(String(clipId))).json()) as ClipPresetBody;
    expect(body.source).toBe("default");
    expect(body.effective.id).toBe("tiktok");
  });

  it("returns 404 for a missing clip", async () => {
    const res = await get("9999");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it.each(["abc", "0", "-1"])("returns 400 invalid_id for %j", async (raw) => {
    const res = await get(raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});

describe("PUT /api/clips/:id/preset", () => {
  it("sets a per-clip override that wins over the project default (source clip)", async () => {
    const { clipId } = seedClip("youtube-shorts");
    const body = (await (await put(String(clipId), { platformPreset: "square" })).json()) as ClipPresetBody;
    expect(body.platformPreset).toBe("square");
    expect(body.projectPreset).toBe("youtube-shorts");
    expect(body.effective.id).toBe("square");
    expect(body.source).toBe("clip");
    // Persisted in the state blob under platformPreset.
    expect(storedState(clipId)?.platformPreset).toBe("square");
  });

  it("preserves other keys in the state blob when writing the override", async () => {
    const { clipId } = seedClip();
    // Pre-seed an existing blob with a timeline the override must not clobber.
    testDb.db
      .insert(clipEdits)
      .values({ clipId, state: JSON.stringify({ timeline: { seq: 3 } }) })
      .run();
    await put(String(clipId), { platformPreset: "instagram-reels" });
    const state = storedState(clipId);
    expect(state?.platformPreset).toBe("instagram-reels");
    expect(state?.timeline).toEqual({ seq: 3 });
  });

  it("clears the override to null, re-inheriting the project default", async () => {
    const { clipId } = seedClip("landscape");
    await put(String(clipId), { platformPreset: "square" });
    const body = (await (await put(String(clipId), { platformPreset: null })).json()) as ClipPresetBody;
    expect(body.platformPreset).toBeNull();
    expect(body.source).toBe("project");
    expect(body.effective.id).toBe("landscape");
    expect(storedState(clipId)).not.toHaveProperty("platformPreset");
  });

  it("rejects an unknown preset id without writing state", async () => {
    const { clipId } = seedClip();
    const res = await put(String(clipId), { platformPreset: "bebo" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_preset");
    expect(storedState(clipId)).toBeNull();
  });

  it("returns 400 for a non-JSON body", async () => {
    const { clipId } = seedClip();
    const res = await put(String(clipId), "not json{", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 404 for a missing clip", async () => {
    const res = await put("8888", { platformPreset: "square" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});
