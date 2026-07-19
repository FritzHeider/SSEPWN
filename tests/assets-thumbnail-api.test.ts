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
let thumbDir: string;

/** JPEG magic bytes so the served body is a plausible poster, not just text. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function request(id: string): Promise<Response> {
  return Promise.resolve(
    GET(new Request(`http://localhost/api/assets/${id}/thumbnail`), {
      params: Promise.resolve({ id }),
    }),
  );
}

/** Insert an asset row, optionally with a poster on disk, and return its id. */
function seedAsset(thumbnailPath: string | null): number {
  const [row] = testDb.db
    .insert(assets)
    .values({ type: "broll", kind: "video", mime: "video/mp4", path: "/tmp/x.mp4", thumbnailPath })
    .returning({ id: assets.id })
    .all();
  return row.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  thumbDir = mkdtempSync(path.join(tmpdir(), "sseclone-thumb-"));
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET } = (await import("../src/app/api/assets/[id]/thumbnail/route")) as { GET: Handler });
});

afterEach(() => {
  testDb.db.delete(assets).run();
});

afterAll(() => {
  testDb.close();
  rmSync(thumbDir, { recursive: true, force: true });
});

describe("GET /api/assets/:id/thumbnail", () => {
  it("streams the poster JPEG for a probed asset", async () => {
    const file = path.join(thumbDir, "asset.jpg");
    writeFileSync(file, JPEG_BYTES);
    const id = seedAsset(file);

    const res = await request(String(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(JPEG_BYTES.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it("404s for an asset with no poster (audio / un-probed)", async () => {
    const id = seedAsset(null);
    const res = await request(String(id));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("no_thumbnail");
  });

  it("404s when the asset does not exist", async () => {
    const res = await request("99999");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("404s when the poster is gone from disk", async () => {
    const id = seedAsset(path.join(thumbDir, "deleted-never-written.jpg"));
    const res = await request(String(id));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("thumbnail_missing");
  });

  it("400s on a non-numeric id rather than touching the filesystem", async () => {
    const res = await request("not-a-number");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});
