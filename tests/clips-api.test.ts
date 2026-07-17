import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { clipEdits, clips, jobs, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type ParamHandler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

let listGET: ParamHandler;
let addPOST: ParamHandler;
let clipDELETE: ParamHandler;
let regeneratePOST: ParamHandler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getClips(id: string): Promise<Response> {
  return listGET(new Request(`http://localhost/api/projects/${id}/clips`), ctx(id));
}

function postClip(id: string, body: unknown, raw = false): Promise<Response> {
  return addPOST(
    new Request(`http://localhost/api/projects/${id}/clips`, {
      method: "POST",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function deleteClip(id: string): Promise<Response> {
  return clipDELETE(new Request(`http://localhost/api/clips/${id}`, { method: "DELETE" }), ctx(id));
}

function regenerate(id: string, body?: unknown, raw = false): Promise<Response> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) init.body = raw ? (body as string) : JSON.stringify(body);
  return regeneratePOST(new Request(`http://localhost/api/projects/${id}/regenerate-clips`, init), ctx(id));
}

function seedProject(overrides: { duration?: number } = {}): number {
  const [row] = testDb.db
    .insert(projects)
    .values({ name: "clips project", duration: overrides.duration ?? null, sourceVideoPath: "/tmp/x.mp4" })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

function seedClip(
  projectId: number,
  values: { inPoint: number; outPoint: number; score?: number | null; reasons?: string[] | null; status?: string; title?: string },
): number {
  const [row] = testDb.db
    .insert(clips)
    .values({
      projectId,
      inPoint: values.inPoint,
      outPoint: values.outPoint,
      score: values.score ?? null,
      reasons: values.reasons ? JSON.stringify(values.reasons) : null,
      status: values.status ?? "candidate",
      title: values.title ?? "clip",
    })
    .returning({ id: clips.id })
    .all();
  return row.id;
}

interface ClipView {
  id: number;
  projectId: number;
  inPoint: number;
  outPoint: number;
  score: number | null;
  title: string | null;
  reasons: string[];
  status: string;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: listGET, POST: addPOST } = (await import("../src/app/api/projects/[id]/clips/route")) as unknown as {
    GET: ParamHandler;
    POST: ParamHandler;
  });
  ({ DELETE: clipDELETE } = (await import("../src/app/api/clips/[id]/route")) as unknown as {
    DELETE: ParamHandler;
  });
  ({ POST: regeneratePOST } = (await import(
    "../src/app/api/projects/[id]/regenerate-clips/route"
  )) as unknown as { POST: ParamHandler });
});

afterEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/projects/:id/clips", () => {
  it("returns clips ranked by score, manual last, with reasons parsed", async () => {
    const id = seedProject();
    seedClip(id, { inPoint: 0, outPoint: 30, score: 0.4, reasons: ["high energy"] });
    seedClip(id, { inPoint: 40, outPoint: 70, score: 0.9, reasons: ["hook phrase: the secret", "laughter"] });
    seedClip(id, { inPoint: 80, outPoint: 90, score: null, status: "manual" });

    const res = await getClips(String(id));
    const body = (await res.json()) as { projectId: number; clips: ClipView[] };

    expect(res.status).toBe(200);
    expect(body.projectId).toBe(id);
    expect(body.clips.map((c) => c.score)).toEqual([0.9, 0.4, null]);
    // Highest-scored clip's reasons round-trip as a real array.
    expect(body.clips[0].reasons).toEqual(["hook phrase: the secret", "laughter"]);
    // Manual clip (no reasons column) reads as an empty array, not null.
    expect(body.clips[2].reasons).toEqual([]);
    expect(body.clips[2].status).toBe("manual");
  });

  it("returns an empty list for a project with no clips", async () => {
    const id = seedProject();
    const res = await getClips(String(id));
    const body = (await res.json()) as { clips: ClipView[] };
    expect(res.status).toBe(200);
    expect(body.clips).toEqual([]);
  });

  it("returns 404 for a project that does not exist", async () => {
    const res = await getClips("9999");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it.each(["abc", "0", "-1", "1.0", ""])("returns 400 invalid_id for %j", async (raw) => {
    const res = await getClips(raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});

describe("POST /api/projects/:id/clips", () => {
  it("adds a manual clip with no score, empty reasons, and manual status", async () => {
    const id = seedProject({ duration: 120 });
    const res = await postClip(String(id), { inPoint: 12.5, outPoint: 42, title: "  my clip  " });
    const body = (await res.json()) as { clip: ClipView };

    expect(res.status).toBe(201);
    expect(body.clip.inPoint).toBe(12.5);
    expect(body.clip.outPoint).toBe(42);
    expect(body.clip.score).toBeNull();
    expect(body.clip.reasons).toEqual([]);
    expect(body.clip.status).toBe("manual");
    expect(body.clip.title).toBe("my clip");

    // Persisted and readable back through the list endpoint.
    const list = (await (await getClips(String(id))).json()) as { clips: ClipView[] };
    expect(list.clips).toHaveLength(1);
    expect(list.clips[0].status).toBe("manual");
  });

  it("defaults the title when none is given", async () => {
    const id = seedProject();
    const body = (await (await postClip(String(id), { inPoint: 0, outPoint: 10 })).json()) as {
      clip: ClipView;
    };
    expect(body.clip.title).toBe("Manual clip");
  });

  it("rejects a non-positive-length range", async () => {
    const id = seedProject();
    const res = await postClip(String(id), { inPoint: 30, outPoint: 30 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_range");
  });

  it("rejects a negative in-point", async () => {
    const id = seedProject();
    const res = await postClip(String(id), { inPoint: -1, outPoint: 10 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_range");
  });

  it("rejects a range past the known source duration", async () => {
    const id = seedProject({ duration: 60 });
    const res = await postClip(String(id), { inPoint: 30, outPoint: 90 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_range");
  });

  it("accepts a range up to the exact source duration", async () => {
    const id = seedProject({ duration: 60 });
    const res = await postClip(String(id), { inPoint: 30, outPoint: 60 });
    expect(res.status).toBe(201);
  });

  it("rejects non-numeric range fields", async () => {
    const id = seedProject();
    const res = await postClip(String(id), { inPoint: "5", outPoint: 10 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_range");
  });

  it("returns 400 for a non-JSON body", async () => {
    const id = seedProject();
    const res = await postClip(String(id), "not json{", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await postClip("8888", { inPoint: 0, outPoint: 10 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});

describe("DELETE /api/clips/:id", () => {
  it("deletes an existing clip", async () => {
    const id = seedProject();
    const clipId = seedClip(id, { inPoint: 0, outPoint: 30, score: 0.5 });
    const res = await deleteClip(String(clipId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(clipId);
    expect(testDb.db.select().from(clips).where(eq(clips.id, clipId)).all()).toHaveLength(0);
  });

  it("deletes a clip that has caption edits, cascading the clip_edits rows", async () => {
    const id = seedProject();
    const clipId = seedClip(id, { inPoint: 0, outPoint: 30, score: 0.5 });
    // The phase-05 caption editor writes a clip_edits row keyed to the clip.
    // With FK enforcement on, deleting the clip used to 500 on this row.
    testDb.db.insert(clipEdits).values({ clipId, state: JSON.stringify({ captions: {} }) }).run();

    const res = await deleteClip(String(clipId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(clipId);
    expect(testDb.db.select().from(clips).where(eq(clips.id, clipId)).all()).toHaveLength(0);
    // The orphan-able child rows are gone too.
    expect(testDb.db.select().from(clipEdits).where(eq(clipEdits.clipId, clipId)).all()).toHaveLength(0);
  });

  it("returns 404 for a clip that does not exist", async () => {
    const res = await deleteClip("7777");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("returns 400 invalid_id for a malformed id", async () => {
    const res = await deleteClip("abc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});

describe("POST /api/projects/:id/regenerate-clips", () => {
  it("enqueues a generate-clips job with no payload for a plain regenerate", async () => {
    const id = seedProject();
    const res = await regenerate(String(id));
    const body = (await res.json()) as { job: { id: number; type: string; projectId: number; payload: unknown } };

    expect(res.status).toBe(202);
    expect(body.job.type).toBe("generate-clips");
    expect(body.job.projectId).toBe(id);
    expect(body.job.payload).toBeNull();

    const row = testDb.db.select().from(jobs).where(eq(jobs.id, body.job.id)).get();
    expect(row?.type).toBe("generate-clips");
    expect(row?.payload).toBeNull();
  });

  it("passes validated overrides as the job payload without persisting them", async () => {
    const id = seedProject();
    const res = await regenerate(String(id), {
      hookPhrases: ["retention", "", 5],
      count: 8,
      bogus: "dropped",
    });
    const body = (await res.json()) as { job: { payload: { hookPhrases: string[]; count: number } } };

    expect(res.status).toBe(202);
    // Garbage dropped by parseClipConfig; clean overrides ride along as payload.
    expect(body.job.payload).toEqual({ hookPhrases: ["retention"], count: 8 });

    // Overrides are per-run only — the project's stored config is untouched.
    const project = testDb.db
      .select({ clipConfig: projects.clipConfig })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(project?.clipConfig).toBeNull();
  });

  it("enqueues with no payload when the body has no valid overrides", async () => {
    const id = seedProject();
    const body = (await (await regenerate(String(id), { onlyGarbage: true })).json()) as {
      job: { payload: unknown };
    };
    expect(body.job.payload).toBeNull();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const id = seedProject();
    const res = await regenerate(String(id), "not json{", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 404 for a project that does not exist", async () => {
    const res = await regenerate("6666");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("returns 400 invalid_id for a malformed id", async () => {
    const res = await regenerate("abc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});
