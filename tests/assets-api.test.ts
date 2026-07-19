import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { assets } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type GetHandler = (request: Request) => Response | Promise<Response>;
type PostHandler = (request: Request) => Promise<Response>;

interface AssetBody {
  asset: {
    id: number;
    kind: string;
    type: string;
    mime: string;
    path: string;
    originalName: string | null;
    projectId: number | null;
  };
}

let GET: GetHandler;
let POST: PostHandler;
let testDb: TestDb;
let assetDir: string;

/** Multipart upload with one file part, as the asset picker would send it. */
function uploadRequest(
  file: { name: string; type: string; body: string },
  fields: Record<string, string> = {},
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new File([file.body], file.name, { type: file.type }));
  return new Request("http://localhost/api/assets", { method: "POST", body: form });
}

function list(query = ""): Promise<Response> {
  return Promise.resolve(GET(new Request(`http://localhost/api/assets${query}`)));
}

beforeAll(async () => {
  testDb = createTestDb();
  assetDir = mkdtempSync(path.join(tmpdir(), "sseclone-assets-"));
  process.env.SSECLONE_DB_PATH = testDb.file;
  process.env.SSECLONE_ASSET_DIR = assetDir;
  ({ GET, POST } = (await import("../src/app/api/assets/route")) as {
    GET: GetHandler;
    POST: PostHandler;
  });
});

afterEach(() => {
  testDb.db.delete(assets).run();
  for (const file of readdirSync(assetDir)) rmSync(path.join(assetDir, file), { force: true });
});

afterAll(() => {
  testDb.close();
  rmSync(assetDir, { recursive: true, force: true });
});

describe("POST /api/assets", () => {
  it("accepts a video upload, classifies it, and stores it on disk", async () => {
    const res = await POST(uploadRequest({ name: "broll.mp4", type: "video/mp4", body: "fake-mp4-bytes" }));
    expect(res.status).toBe(201);
    const { asset } = (await res.json()) as AssetBody;
    expect(asset.kind).toBe("video");
    expect(asset.type).toBe("video"); // role defaults to kind
    expect(asset.mime).toBe("video/mp4");
    expect(asset.originalName).toBe("broll.mp4");
    expect(readdirSync(assetDir)).toHaveLength(1);
  });

  it("accepts an audio upload", async () => {
    const res = await POST(uploadRequest({ name: "whoosh.mp3", type: "audio/mpeg", body: "fake-mp3" }));
    expect(res.status).toBe(201);
    expect((await res.json() as AssetBody).asset.kind).toBe("audio");
  });

  it("accepts an image upload and honours an explicit role field", async () => {
    const res = await POST(
      uploadRequest({ name: "logo.png", type: "image/png", body: "fake-png" }, { type: "logo" }),
    );
    expect(res.status).toBe(201);
    const { asset } = (await res.json()) as AssetBody;
    expect(asset.kind).toBe("image");
    expect(asset.type).toBe("logo");
  });

  it("rejects a non-media upload without writing anything to disk", async () => {
    const res = await POST(uploadRequest({ name: "notes.txt", type: "text/plain", body: "hello" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe("unsupported_type");
    expect(readdirSync(assetDir)).toHaveLength(0);
  });

  it("rejects a mismatched extension (renamed file)", async () => {
    const res = await POST(uploadRequest({ name: "trojan.mp4", type: "application/pdf", body: "%PDF" }));
    expect(res.status).toBe(400);
    expect(readdirSync(assetDir)).toHaveLength(0);
  });
});

describe("GET /api/assets", () => {
  it("lists newest-first and filters by kind", async () => {
    await POST(uploadRequest({ name: "a.mp4", type: "video/mp4", body: "v" }));
    await POST(uploadRequest({ name: "b.mp3", type: "audio/mpeg", body: "a" }));
    await POST(uploadRequest({ name: "c.png", type: "image/png", body: "i" }));

    const all = (await (await list()).json()) as { assets: AssetBody["asset"][] };
    expect(all.assets).toHaveLength(3);

    const audio = (await (await list("?kind=audio")).json()) as { assets: AssetBody["asset"][] };
    expect(audio.assets).toHaveLength(1);
    expect(audio.assets[0].kind).toBe("audio");
  });

  it("rejects an unknown kind filter", async () => {
    const res = await list("?kind=bogus");
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe("bad_kind");
  });
});
