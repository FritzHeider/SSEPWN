import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects } from "../src/lib/db/schema";
import { DEFAULT_CLIP_CONFIG } from "../src/lib/highlights/config";
import { DEFAULT_HOOK_PHRASES } from "../src/lib/highlights/score";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let GET: Handler;
let PUT: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/projects/${id}/clip-config`), ctx(id));
}

function put(id: string, body: unknown, raw = false): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/projects/${id}/clip-config`, {
      method: "PUT",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function seed(): number {
  const [row] = testDb.db
    .insert(projects)
    .values({ name: "clip-config project" })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

interface ConfigBody {
  projectId: number;
  overrides: Record<string, unknown>;
  effective: Record<string, unknown>;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET, PUT } = (await import("../src/app/api/projects/[id]/clip-config/route")) as unknown as {
    GET: Handler;
    PUT: Handler;
  });
});

afterEach(() => {
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/projects/:id/clip-config", () => {
  it("returns empty overrides and the pure defaults for an unconfigured project", async () => {
    const id = seed();
    const res = await get(String(id));
    const body = (await res.json()) as ConfigBody;

    expect(res.status).toBe(200);
    expect(body.projectId).toBe(id);
    expect(body.overrides).toEqual({});
    expect(body.effective).toMatchObject(DEFAULT_CLIP_CONFIG);
    expect(body.effective.hookPhrases).toEqual([...DEFAULT_HOOK_PHRASES]);
  });

  it("returns 404 for a project that does not exist", async () => {
    const res = await get("9999");
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(404);
    expect(body.code).toBe("not_found");
  });

  it.each(["abc", "0", "-1", "1.0", " 1 ", ""])("returns 400 invalid_id for %j", async (raw) => {
    const res = await get(raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});

describe("PUT /api/projects/:id/clip-config", () => {
  it("persists only well-typed overrides and reflects them in the effective config", async () => {
    const id = seed();
    const res = await put(id.toString(), {
      minLen: 20,
      count: 8,
      hookPhrases: ["retention", "", 7],
      bogus: "ignored",
      weights: { hook: 3, nonsense: 1 },
    });
    const body = (await res.json()) as ConfigBody;

    expect(res.status).toBe(200);
    // Garbage keys/values dropped; good ones kept.
    expect(body.overrides).toEqual({
      minLen: 20,
      count: 8,
      hookPhrases: ["retention"],
      weights: { hook: 3 },
    });
    // Effective = overrides merged onto defaults.
    expect(body.effective.minLen).toBe(20);
    expect(body.effective.count).toBe(8);
    expect(body.effective.maxLen).toBe(DEFAULT_CLIP_CONFIG.maxLen);
    expect(body.effective.hookPhrases).toEqual(["retention"]);

    // Cleaned form is what lands in the column — a later generate run never sees
    // the stray `bogus`/`nonsense` keys.
    const stored = testDb.db
      .select({ clipConfig: projects.clipConfig })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(JSON.parse(stored?.clipConfig ?? "{}")).toEqual(body.overrides);
  });

  it("round-trips through GET after a PUT", async () => {
    const id = seed();
    await put(id.toString(), { windowLen: 45 });
    const body = (await (await get(String(id))).json()) as ConfigBody;
    expect(body.overrides).toEqual({ windowLen: 45 });
    expect(body.effective.windowLen).toBe(45);
  });

  it("clears the override to null when no valid fields remain, reverting to defaults", async () => {
    const id = seed();
    await put(id.toString(), { minLen: 25 });
    // A body with nothing valid resets the project.
    const res = await put(id.toString(), { onlyGarbage: true });
    const body = (await res.json()) as ConfigBody;

    expect(body.overrides).toEqual({});
    expect(body.effective).toMatchObject(DEFAULT_CLIP_CONFIG);
    const stored = testDb.db
      .select({ clipConfig: projects.clipConfig })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(stored?.clipConfig).toBeNull();
  });

  it("returns 400 for a non-JSON body", async () => {
    const id = seed();
    const res = await put(id.toString(), "not json{", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 404 when updating a project that does not exist", async () => {
    const res = await put("8888", { minLen: 20 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("returns 400 invalid_id without touching the database", async () => {
    const res = await put("abc", { minLen: 20 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});
