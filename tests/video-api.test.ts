import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type ItemHandler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getVideo: ItemHandler;
let testDb: TestDb;
let uploadDir: string;

/** Next 16 hands dynamic routes their params as a promise. */
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string, range?: string): Promise<Response> {
  return getVideo(
    new Request(`http://localhost/api/projects/${id}/video`, {
      headers: range ? { range } : undefined,
    }),
    ctx(id),
  );
}

async function bodyBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Header-only assertions still have to drain the body: the response streams
 * straight off an open fd, which is released when the stream ends or is
 * destroyed. Dropping the Response on the floor leaks the fd until GC — real
 * clients always consume or cancel, so this keeps the test honest about it
 * rather than papering over it with a warning.
 */
async function headersOf(response: Response): Promise<Headers> {
  await response.arrayBuffer();
  return response.headers;
}

/**
 * Deterministic pseudo-video bytes, larger than one stream chunk so a route that
 * only ever emits its first chunk cannot pass. `seed` makes each project's video
 * distinguishable BY CONTENT — length alone would let a route that returns the
 * file's first N bytes for every range look correct.
 */
function videoBytes(seed: number, size = 200 * 1024): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 37 + seed * 53) % 256;
  return bytes;
}

function writeVideo(name: string, bytes: Buffer): string {
  const file = path.join(uploadDir, name);
  writeFileSync(file, bytes);
  return file;
}

function seedProject(values: { name: string; sourceVideoPath?: string | null }): number {
  const [row] = testDb.db
    .insert(projects)
    .values({ name: values.name, status: "ready", sourceVideoPath: values.sourceVideoPath ?? null })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

/** A project whose source video is `bytes` on disk, stored under a UUID-ish name. */
function seedWithVideo(name: string, bytes: Buffer, filename = `${name}.mp4`): number {
  return seedProject({ name, sourceVideoPath: writeVideo(filename, bytes) });
}

beforeAll(async () => {
  testDb = createTestDb();
  uploadDir = mkdtempSync(path.join(tmpdir(), "sseclone-uploads-"));
  // The route imports the db singleton, which opens its file at import time —
  // point it at the migrated test db before that import happens.
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: getVideo } = (await import("../src/app/api/projects/[id]/video/route")) as unknown as {
    GET: ItemHandler;
  });
});

afterEach(() => {
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe("GET /api/projects/:id/video — whole file", () => {
  it("serves the source video with its length and content type", async () => {
    const bytes = videoBytes(1);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(await bodyBytes(response)).toEqual(bytes);
  });

  /**
   * Without Accept-Ranges the UA never ATTEMPTS a range request, so every other
   * behaviour in this file goes unexercised in a real browser while the suite
   * stays green — and seek-on-click quietly refetches from byte 0.
   */
  it("advertises range support so the browser will try to seek", async () => {
    const id = seedWithVideo("clip", videoBytes(1));

    expect((await headersOf(await get(String(id)))).get("accept-ranges")).toBe("bytes");
  });

  it("derives the content type from the stored extension, not a fixed guess", async () => {
    const webm = seedWithVideo("webm-clip", videoBytes(2), "webm-clip.webm");
    const mov = seedWithVideo("mov-clip", videoBytes(3), "mov-clip.mov");

    expect((await headersOf(await get(String(webm)))).get("content-type")).toBe("video/webm");
    expect((await headersOf(await get(String(mov)))).get("content-type")).toBe("video/quicktime");
  });

  /** Mislabelled bytes fail as an opaque decode error; unlabelled ones fail loudly. */
  it("falls back to octet-stream rather than mislabelling an unknown extension", async () => {
    const id = seedWithVideo("odd", videoBytes(4), "odd.bin");

    expect((await headersOf(await get(String(id)))).get("content-type")).toBe("application/octet-stream");
  });
});

describe("GET /api/projects/:id/video — range requests", () => {
  it("answers a mid-file range with 206 and exactly those bytes", async () => {
    const bytes = videoBytes(5);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id), "bytes=1000-1999");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${bytes.length}`);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    // Compared by CONTENT: a route serving the first 1000 bytes for every range
    // would satisfy a length-only assertion.
    expect(await bodyBytes(response)).toEqual(bytes.subarray(1000, 2000));
  });

  it("treats the range as inclusive on both ends", async () => {
    const bytes = videoBytes(6);
    const id = seedWithVideo("clip", bytes);

    // 100% error under an `end - start` length mutant, so it cannot line up by
    // luck the way a longer range might.
    const response = await get(String(id), "bytes=0-0");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-0/${bytes.length}`);
    expect(await bodyBytes(response)).toEqual(bytes.subarray(0, 1));
  });

  it("runs an open-ended range to the end of the file", async () => {
    const bytes = videoBytes(7);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id), `bytes=${bytes.length - 10}-`);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes ${bytes.length - 10}-${bytes.length - 1}/${bytes.length}`,
    );
    expect(await bodyBytes(response)).toEqual(bytes.subarray(bytes.length - 10));
  });

  it("answers a suffix range with the LAST n bytes", async () => {
    const bytes = videoBytes(8);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id), "bytes=-500");

    expect(response.status).toBe(206);
    // The tail, not "from byte 500" — a parser that confuses the two returns a
    // plausible 206 full of the wrong half of the file.
    expect(await bodyBytes(response)).toEqual(bytes.subarray(bytes.length - 500));
    expect(response.headers.get("content-length")).toBe("500");
  });

  it("clamps an end past EOF instead of failing a normal browser request", async () => {
    const bytes = videoBytes(9);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id), "bytes=0-999999999");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`);
    expect(await bodyBytes(response)).toEqual(bytes);
  });

  it("rejects a range starting past EOF with 416 and the real length", async () => {
    const bytes = videoBytes(10);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id), `bytes=${bytes.length + 10}-`);

    // A 200 here would tell the UA its seek succeeded, and it would render the
    // bytes at the wrong offset.
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    expect(await bodyBytes(response)).toEqual(Buffer.alloc(0));
  });

  it.each([
    ["garbage", "bytes=abc"],
    ["an inverted range", "bytes=9-2"],
    ["an unknown unit", "items=0-10"],
    ["a multi-range request", "bytes=0-1,5-6"],
  ])("ignores %s and serves the whole file with 200", async (_label, header) => {
    const bytes = videoBytes(11);
    const id = seedWithVideo("clip", bytes);

    const response = await get(String(id), header);

    // Not 416 (the client's offset is not the problem) and not a 206 carrying
    // only part of what was asked for.
    expect(response.status).toBe(200);
    expect(await bodyBytes(response)).toEqual(bytes);
  });
});

describe("GET /api/projects/:id/video — the id selects the video", () => {
  /**
   * Two projects with DIFFERENT content, each asserted to own its own: a route
   * that ignores :id and serves whichever video it finds first passes any
   * single-project test.
   */
  it("serves each project its own video, not whichever it finds", async () => {
    const first = videoBytes(21);
    const second = videoBytes(22);
    const firstId = seedWithVideo("first", first, "first.mp4");
    const secondId = seedWithVideo("second", second, "second.mp4");

    expect(await bodyBytes(await get(String(firstId)))).toEqual(first);
    expect(await bodyBytes(await get(String(secondId)))).toEqual(second);
    expect(first).not.toEqual(second);
  });

  it("keeps ranges bound to the requested project too", async () => {
    const first = videoBytes(23);
    const second = videoBytes(24);
    seedWithVideo("first", first, "first-r.mp4");
    const secondId = seedWithVideo("second", second, "second-r.mp4");

    const response = await get(String(secondId), "bytes=100-199");

    expect(await bodyBytes(response)).toEqual(second.subarray(100, 200));
  });
});

describe("GET /api/projects/:id/video — failure paths", () => {
  it.each(["abc", "0", "1.0", "-1", " 1", "1e3"])("rejects the malformed id %j with 400", async (id) => {
    const response = await get(id);

    // 400 invalid_id, never a 404: a typo is the client's mistake to see, and a
    // 404 would claim the id was well-formed but absent.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_id" });
  });

  it("404s a well-formed id with no project", async () => {
    const response = await get("4242");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  /** A project created but never ingested has no path yet — distinct from a bad id. */
  it("404s a project with no source video, with its own code", async () => {
    const id = seedProject({ name: "no source yet", sourceVideoPath: null });

    const response = await get(String(id));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "no_source_video" });
  });

  /**
   * data/ is a scratch directory. The fd is opened before the response is built
   * precisely so a deleted file becomes a 404 rather than a truncated 200.
   */
  it("404s when the stored file is gone from disk", async () => {
    const file = writeVideo("vanishing.mp4", videoBytes(31));
    const id = seedProject({ name: "vanishing", sourceVideoPath: file });
    unlinkSync(file);

    const response = await get(String(id));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "source_video_missing" });
  });

  it("404s when the stored path is a directory rather than a file", async () => {
    const id = seedProject({ name: "dir", sourceVideoPath: uploadDir });

    const response = await get(String(id));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "source_video_missing" });
  });

  it("serves an empty file as an empty 200 but 416s any range over it", async () => {
    const id = seedWithVideo("empty", Buffer.alloc(0), "empty.mp4");

    const whole = await get(String(id));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("0");

    const ranged = await get(String(id), "bytes=0-");
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });
});
