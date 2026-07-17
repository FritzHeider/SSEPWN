import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { jobs, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

type PostHandler = (request: Request) => Promise<Response>;

let POST: PostHandler;
let testDb: TestDb;
let uploadsDir: string;

/** Multipart request carrying one file part, as a browser would send it. */
function uploadRequest(
  file: { name: string; type: string; body: Uint8Array<ArrayBuffer> | string },
  fields: Record<string, string> = {},
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new File([file.body], file.name, { type: file.type }));
  return new Request("http://localhost/api/projects", { method: "POST", body: form });
}

/** Copied into a plain ArrayBuffer so the bytes are a valid BlobPart. */
function fixture(name: string): Uint8Array<ArrayBuffer> {
  const contents = readFileSync(path.join(FIXTURES, name));
  const bytes = new Uint8Array(new ArrayBuffer(contents.byteLength));
  bytes.set(contents);
  return bytes;
}

function uploadedFiles(): string[] {
  return readdirSync(uploadsDir);
}

beforeAll(async () => {
  testDb = createTestDb();
  uploadsDir = mkdtempSync(path.join(tmpdir(), "sseclone-uploads-"));
  // The route imports the db singleton, which opens its file at import time —
  // point it at the migrated test db before that import happens.
  process.env.SSECLONE_DB_PATH = testDb.file;
  process.env.SSECLONE_UPLOAD_DIR = uploadsDir;
  ({ POST } = (await import("../src/app/api/projects/route")) as { POST: PostHandler });
});

afterEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(projects).run();
  for (const file of uploadedFiles()) rmSync(path.join(uploadsDir, file), { force: true });
  delete process.env.SSECLONE_MAX_UPLOAD_BYTES;
});

afterAll(() => {
  testDb.close();
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe("POST /api/projects", () => {
  it("stores the upload and queues an ingest job", async () => {
    const video = fixture("short-sample.mp4");
    const response = await POST(uploadRequest({ name: "short-sample.mp4", type: "video/mp4", body: video }));

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      project: { id: number; name: string; status: string; sourceVideoPath: string };
      job: { id: number; type: string; status: string; projectId: number; payload: unknown };
    };

    expect(body.project.status).toBe("uploaded");
    expect(body.project.name).toBe("short-sample.mp4");
    expect(body.job).toMatchObject({ type: "ingest", status: "queued", projectId: body.project.id });
    expect(body.job.payload).toEqual({ path: body.project.sourceVideoPath });

    // The whole file reached disk, byte for byte.
    expect(statSync(body.project.sourceVideoPath).size).toBe(video.byteLength);
    expect(path.dirname(body.project.sourceVideoPath)).toBe(uploadsDir);

    // ...and the rows are really persisted, not just echoed back.
    expect(testDb.db.select().from(projects).all()).toHaveLength(1);
    const stored = testDb.db.select().from(jobs).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "ingest", status: "queued", attempts: 0 });
  });

  it("uses the supplied name field over the filename", async () => {
    const response = await POST(
      uploadRequest({ name: "short-sample.mp4", type: "video/mp4", body: fixture("short-sample.mp4") }, { name: "My Podcast Ep. 1" }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { project: { name: string } };
    expect(body.project.name).toBe("My Podcast Ep. 1");
  });

  it("rejects a non-video upload with a 400 JSON error", async () => {
    const response = await POST(
      uploadRequest({ name: "not-a-video.txt", type: "text/plain", body: fixture("not-a-video.txt") }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("unsupported_type");
    expect(body.error).toMatch(/text\/plain/);

    // Nothing was registered and nothing was written.
    expect(testDb.db.select().from(projects).all()).toHaveLength(0);
    expect(testDb.db.select().from(jobs).all()).toHaveLength(0);
    expect(uploadedFiles()).toEqual([]);
  });

  it("rejects a video mime type carrying a non-video extension", async () => {
    // A client claiming video/mp4 for payload.txt must not smuggle it through.
    const response = await POST(uploadRequest({ name: "payload.txt", type: "video/mp4", body: "not really a video" }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("unsupported_type");
    expect(uploadedFiles()).toEqual([]);
  });

  it("rejects a video extension carrying a non-video mime type", async () => {
    const response = await POST(uploadRequest({ name: "sneaky.mp4", type: "text/plain", body: "not really a video" }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("unsupported_type");
    expect(uploadedFiles()).toEqual([]);
  });

  it("accepts mov and webm", async () => {
    for (const [name, type] of [
      ["clip.mov", "video/quicktime"],
      ["clip.webm", "video/webm"],
    ]) {
      const response = await POST(uploadRequest({ name, type, body: fixture("short-sample.mp4") }));
      expect(response.status, `${name} should be accepted`).toBe(201);
    }
  });

  it("rejects an oversize upload with a 400 JSON error", async () => {
    process.env.SSECLONE_MAX_UPLOAD_BYTES = "1024";
    const response = await POST(
      uploadRequest({ name: "short-sample.mp4", type: "video/mp4", body: fixture("short-sample.mp4") }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("too_large");
    expect(body.error).toMatch(/maximum upload size/);

    // The partial write is cleaned up, and no project is left behind.
    expect(uploadedFiles()).toEqual([]);
    expect(testDb.db.select().from(projects).all()).toHaveLength(0);
  });

  it("rejects a request that is not multipart", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "no file here" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("not_multipart");
  });

  it("rejects a multipart request with no file part", async () => {
    const form = new FormData();
    form.append("name", "fields only");
    const response = await POST(new Request("http://localhost/api/projects", { method: "POST", body: form }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("no_file");
  });
});
