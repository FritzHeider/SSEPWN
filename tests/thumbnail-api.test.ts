import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type ItemHandler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getThumbnail: ItemHandler;
let testDb: TestDb;
let posterDir: string;

/** Next 16 hands dynamic routes their params as a promise. */
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(id: string): Request {
  return new Request(`http://localhost/api/projects/${id}/thumbnail`);
}

/**
 * Deterministic poster bytes, deliberately larger than a stream chunk: a poster
 * that fits in one read would pass even if the route only ever emitted its first
 * chunk. `seed` makes each project's poster distinguishable by content.
 */
function posterBytes(seed: number, size = 200 * 1024): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + seed * 17) % 256;
  return bytes;
}

function writePoster(name: string, bytes: Buffer): string {
  const file = path.join(posterDir, name);
  writeFileSync(file, bytes);
  return file;
}

function seedProject(values: { name: string; status: string; thumbnailPath?: string | null }): number {
  const [row] = testDb.db
    .insert(projects)
    .values({
      name: values.name,
      status: values.status,
      thumbnailPath: values.thumbnailPath ?? null,
    })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  posterDir = mkdtempSync(path.join(tmpdir(), "sseclone-posters-"));
  // The route imports the db singleton, which opens its file at import time —
  // point it at the migrated test db before that import happens.
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: getThumbnail } = (await import("../src/app/api/projects/[id]/thumbnail/route")) as unknown as {
    GET: ItemHandler;
  });
});

afterEach(() => {
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
  rmSync(posterDir, { recursive: true, force: true });
});

describe("GET /api/projects/:id/thumbnail", () => {
  it("streams the poster byte-exact, as a JPEG of the right length", async () => {
    const bytes = posterBytes(1);
    const id = seedProject({ name: "podcast.mp4", status: "ready", thumbnailPath: writePoster("a.jpg", bytes) });

    const response = await getThumbnail(request(String(id)), ctx(String(id)));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    // Byte-exact, not just "non-empty": a poster that streams its first chunk and
    // stops, or one served from the wrong file, both survive a length-only check.
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("serves the requested project's poster, not some other project's", async () => {
    // Two projects with DIFFERENT poster bytes: a single-project fixture passes a
    // route that ignores the id entirely and serves whatever row comes back first.
    const firstBytes = posterBytes(2);
    const secondBytes = posterBytes(99);
    seedProject({ name: "first.mp4", status: "ready", thumbnailPath: writePoster("first.jpg", firstBytes) });
    const secondId = seedProject({
      name: "second.mp4",
      status: "ready",
      thumbnailPath: writePoster("second.jpg", secondBytes),
    });

    const response = await getThumbnail(request(String(secondId)), ctx(String(secondId)));

    expect(response.status).toBe(200);
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(secondBytes)).toBe(true);
    expect(served.equals(firstBytes)).toBe(false);
  });

  it("rejects a non-numeric id with 400, not a misleading 404", async () => {
    const response = await getThumbnail(request("abc"), ctx("abc"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_id" });
  });

  it("returns 404 for a project that does not exist", async () => {
    const response = await getThumbnail(request("4321"), ctx("4321"));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("returns 404 while a project is still awaiting ingest and has no poster", async () => {
    const id = seedProject({ name: "pending.mp4", status: "uploaded", thumbnailPath: null });

    const response = await getThumbnail(request(String(id)), ctx(String(id)));

    // Must not be a 200 with an empty body — the UI decides whether to render an
    // <img> from the status code.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "no_thumbnail" });
  });

  it("returns 404 when the row points at a poster that is gone from disk", async () => {
    // data/ is a scratch directory; a cleaned poster leaves the row behind. The
    // failure has to land on the status code, not halfway through a 200 body.
    const file = writePoster("vanishing.jpg", posterBytes(3));
    const id = seedProject({ name: "cleaned.mp4", status: "ready", thumbnailPath: file });
    unlinkSync(file);

    const response = await getThumbnail(request(String(id)), ctx(String(id)));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "thumbnail_missing" });
  });
});
