import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, describe, it } from "vitest";

import { assets } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Response | Promise<Response>;

let GET: Handler;
let testDb: TestDb;
let assetDir: string;

/** A few bytes so Range math has something real to slice. */
const BYTES = Buffer.from("mp4-body-0123456789", "utf8");

function request(id: string, range?: string): Promise<Response> {
  const headers = range ? { range } : undefined;
  return Promise.resolve(
    GET(new Request(`http://localhost/api/assets/${id}/file`, { headers }), {
      params: Promise.resolve({ id }),
    }),
  );
}

/** Insert an asset row pointing at `filePath` (which may not exist). */
function seedAsset(filePath: string, mime: string | null = "video/mp4"): number {
  const [row] = testDb.db
    .insert(assets)
    .values({ type: "broll", kind: "video", mime, path: filePath })
    .returning({ id: assets.id })
    .all();
  return row.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  assetDir = mkdtempSync(path.join(tmpdir(), "sseclone-asset-"));
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET } = (await import("../src/app/api/assets/[id]/file/route")) as { GET: Handler });
});

afterEach(() => {
  testDb.db.delete(assets).run();
});

afterAll(() => {
  testDb.close();
  rmSync(assetDir, { recursive: true, force: true });
});

describe("GET /api/assets/:id/file", () => {
  it("streams the whole file with the stored MIME and Accept-Ranges", async () => {
    const file = path.join(assetDir, "a.mp4");
    writeFileSync(file, BYTES);
    const res = await request(String(seedAsset(file)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(BYTES.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("serves a partial 206 for a Range request", async () => {
    const file = path.join(assetDir, "b.mp4");
    writeFileSync(file, BYTES);
    const res = await request(String(seedAsset(file)), "bytes=0-3");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${BYTES.length}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES.subarray(0, 4));
  });

  it("returns 416 for an unsatisfiable Range", async () => {
    const file = path.join(assetDir, "c.mp4");
    writeFileSync(file, BYTES);
    const res = await request(String(seedAsset(file)), "bytes=99999-");
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BYTES.length}`);
  });

  it("falls back to octet-stream when the asset has no stored MIME", async () => {
    const file = path.join(assetDir, "d.bin");
    writeFileSync(file, BYTES);
    const res = await request(String(seedAsset(file, null)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("404s when the asset does not exist", async () => {
    const res = await request("99999");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("404s when the file is gone from disk", async () => {
    const id = seedAsset(path.join(assetDir, "never-written.mp4"));
    const res = await request(String(id));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("asset_missing");
  });

  it("400s on a non-numeric id rather than touching the filesystem", async () => {
    const res = await request("not-a-number");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});
