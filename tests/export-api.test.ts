import { writeFileSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clipEdits, clips, exports, jobs, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let clipExportPOST: Handler;
let clipExportGET: Handler;
let exportGET: Handler;
let downloadGET: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function post(id: string, body?: unknown, raw = false): Promise<Response> {
  return clipExportPOST(
    new Request(`http://localhost/api/clips/${id}/export`, {
      method: "POST",
      body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function listExports(clipId: string): Promise<Response> {
  return clipExportGET(new Request(`http://localhost/api/clips/${clipId}/export`), ctx(clipId));
}

function getExport(id: string): Promise<Response> {
  return exportGET(new Request(`http://localhost/api/exports/${id}`), ctx(id));
}

function download(id: string): Promise<Response> {
  return downloadGET(new Request(`http://localhost/api/exports/${id}/download`), ctx(id));
}

/** Seed one project (optional default preset) + one clip, return their ids. */
function seedClip(opts: { projectPreset?: string; clipPreset?: string } = {}): {
  clipId: number;
  projectId: number;
} {
  const [project] = testDb.db
    .insert(projects)
    .values({ name: "export api project", platformPreset: opts.projectPreset ?? null })
    .returning({ id: projects.id })
    .all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  if (opts.clipPreset) {
    testDb.db
      .insert(clipEdits)
      .values({ clipId: clip.id, state: JSON.stringify({ platformPreset: opts.clipPreset }) })
      .run();
  }
  return { clipId: clip.id, projectId: project.id };
}

interface ExportRow {
  id: number;
  clipId: number;
  preset: string;
  status: string;
  outputPath: string | null;
  jobId: number | null;
  error: string | null;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ POST: clipExportPOST, GET: clipExportGET } = (await import(
    "../src/app/api/clips/[id]/export/route"
  )) as unknown as { POST: Handler; GET: Handler });
  ({ GET: exportGET } = (await import("../src/app/api/exports/[id]/route")) as unknown as {
    GET: Handler;
  });
  ({ GET: downloadGET } = (await import(
    "../src/app/api/exports/[id]/download/route"
  )) as unknown as { GET: Handler });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  // Isolate rows between cases without reopening the shared connection.
  testDb.db.delete(exports).run();
  testDb.db.delete(jobs).run();
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

describe("POST /api/clips/:id/export", () => {
  it("creates an exports row, enqueues an export job, and links the job back", async () => {
    const { clipId, projectId } = seedClip({ projectPreset: "tiktok" });

    const res = await post(String(clipId), { quality: "draft" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { export: ExportRow; quality: string };
    expect(body.quality).toBe("draft");
    expect(body.export.clipId).toBe(clipId);
    expect(body.export.preset).toBe("tiktok");
    expect(body.export.status).toBe("queued");
    expect(body.export.jobId).toBeGreaterThan(0);

    // exports row persisted with the jobId set.
    const row = testDb.db.select().from(exports).where(eq(exports.id, body.export.id)).get();
    expect(row?.jobId).toBe(body.export.jobId);

    // A matching export job was queued on the clip's project with the payload.
    const job = testDb.db.select().from(jobs).where(eq(jobs.id, body.export.jobId!)).get();
    expect(job?.type).toBe("export");
    expect(job?.projectId).toBe(projectId);
    expect(job?.status).toBe("queued");
    expect(JSON.parse(job!.payload!)).toEqual({ exportId: body.export.id, quality: "draft" });
  });

  it("defaults quality to final and preset to the clip's effective preset", async () => {
    // Clip override (youtube) wins over the project default (tiktok).
    const { clipId } = seedClip({ projectPreset: "tiktok", clipPreset: "youtube-shorts" });

    const res = await post(String(clipId)); // no body at all
    expect(res.status).toBe(201);
    const body = (await res.json()) as { export: ExportRow; quality: string };
    expect(body.quality).toBe("final");
    expect(body.export.preset).toBe("youtube-shorts");
  });

  it("accepts an explicit preset override in the body", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const res = await post(String(clipId), { preset: "instagram-reels" });
    const body = (await res.json()) as { export: ExportRow };
    expect(body.export.preset).toBe("instagram-reels");
  });

  it("rejects a bad id, missing clip, bad preset, and bad quality", async () => {
    expect((await post("0", {})).status).toBe(400);
    expect((await post("abc", {})).status).toBe(400);
    expect((await post("999", {})).status).toBe(404);

    const { clipId } = seedClip({ projectPreset: "tiktok" });
    expect((await post(String(clipId), { preset: "myspace" })).status).toBe(400);
    expect((await post(String(clipId), { quality: "ultra" })).status).toBe(400);
    expect((await post(String(clipId), "{not json", true)).status).toBe(400);
  });
});

describe("GET /api/clips/:id/export (history)", () => {
  it("lists a clip's exports newest first", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const first = (await (await post(String(clipId), { preset: "tiktok" })).json()) as {
      export: ExportRow;
    };
    const second = (await (await post(String(clipId), { preset: "youtube-shorts" })).json()) as {
      export: ExportRow;
    };

    const res = await listExports(String(clipId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exports: ExportRow[] };
    expect(body.exports.map((e) => e.id)).toEqual([second.export.id, first.export.id]);
  });

  it("404s for a missing clip", async () => {
    expect((await listExports("999")).status).toBe(404);
  });
});

describe("GET /api/exports/:id", () => {
  it("joins the render job for status + live progress", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const created = (await (await post(String(clipId), { quality: "draft" })).json()) as {
      export: ExportRow;
    };

    // Simulate the worker advancing the render.
    testDb.db.update(jobs).set({ status: "running", progress: 42 }).where(eq(jobs.id, created.export.jobId!)).run();
    testDb.db.update(exports).set({ status: "running" }).where(eq(exports.id, created.export.id)).run();

    const res = await getExport(String(created.export.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; progress: number; error: string | null };
    expect(body.status).toBe("running");
    expect(body.progress).toBe(42);
    expect(body.error).toBeNull();
  });

  it("pins progress to 100 once the export is done", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const created = (await (await post(String(clipId))).json()) as { export: ExportRow };
    testDb.db.update(exports).set({ status: "done" }).where(eq(exports.id, created.export.id)).run();

    const body = (await (await getExport(String(created.export.id))).json()) as { progress: number };
    expect(body.progress).toBe(100);
  });

  it("surfaces a failure error and 404s for a missing export", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const created = (await (await post(String(clipId))).json()) as { export: ExportRow };
    testDb.db
      .update(exports)
      .set({ status: "failed", error: "ffmpeg exited 1: no such file" })
      .where(eq(exports.id, created.export.id))
      .run();

    const body = (await (await getExport(String(created.export.id))).json()) as {
      status: string;
      error: string | null;
    };
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/no such file/);

    expect((await getExport("999")).status).toBe(404);
    expect((await getExport("0")).status).toBe(400);
  });
});

describe("GET /api/exports/:id/download", () => {
  it("streams a done export as an mp4 attachment", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const created = (await (await post(String(clipId))).json()) as { export: ExportRow };

    const filePath = path.join(testDb.file, "..", `${clipId}-tiktok.mp4`);
    writeFileSync(filePath, "not-a-real-mp4-but-bytes");
    testDb.db
      .update(exports)
      .set({ status: "done", outputPath: filePath })
      .where(eq(exports.id, created.export.id))
      .run();

    const res = await download(String(created.export.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    // Filename is derived from the clip title slug + preset id + aspect ratio,
    // not the on-disk <clipId>-<preset>.mp4. The seeded clip title is "c".
    expect(res.headers.get("content-disposition")).toContain("c-tiktok-9x16.mp4");
    expect(await res.text()).toBe("not-a-real-mp4-but-bytes");
  });

  it("409s when the export is not yet done, 404 when the file is gone", async () => {
    const { clipId } = seedClip({ projectPreset: "tiktok" });
    const created = (await (await post(String(clipId))).json()) as { export: ExportRow };

    // Still queued -> not ready.
    expect((await download(String(created.export.id))).status).toBe(409);

    // Marked done but the file was never written -> 404.
    testDb.db
      .update(exports)
      .set({ status: "done", outputPath: path.join(testDb.file, "..", "gone.mp4") })
      .where(eq(exports.id, created.export.id))
      .run();
    expect((await download(String(created.export.id))).status).toBe(404);

    expect((await download("999")).status).toBe(404);
    expect((await download("0")).status).toBe(400);
  });
});
