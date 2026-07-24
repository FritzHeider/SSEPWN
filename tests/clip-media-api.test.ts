import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clips, projects } from "../src/lib/db/schema";
import { clipThumbnailPath, waveformPath } from "../src/lib/media/derived";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let clipThumbGET: Handler;
let waveformGET: Handler;
let clipDELETE: Handler;
let projectDELETE: Handler;
let testDb: TestDb;
let derivedDir: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function seedProject(): number {
  // A throwaway source file under the test's own dir — NOT a real fixture: the
  // project-delete cascade unlinks sourceVideoPath, and pointing it at a shared
  // fixture would delete it mid-run and break every downstream ffmpeg test.
  const source = path.join(derivedDir, `source-${Date.now()}-${Math.random()}.mp4`);
  writeDerived(source, "src");
  const [row] = testDb.db
    .insert(projects)
    .values({ name: "p", status: "ready", sourceVideoPath: source })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

function seedClip(projectId: number): number {
  const [row] = testDb.db
    .insert(clips)
    .values({ projectId, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return row.id;
}

/** Write a fake derived file at a deterministic derived path. */
function writeDerived(p: string, bytes = "img"): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, bytes);
}

beforeAll(async () => {
  testDb = createTestDb();
  derivedDir = mkdtempSync(path.join(tmpdir(), "sseclone-derived-"));
  process.env.SSECLONE_DB_PATH = testDb.file;
  process.env.SSECLONE_CLIP_THUMB_DIR = path.join(derivedDir, "clip-thumbs");
  process.env.SSECLONE_WAVEFORM_DIR = path.join(derivedDir, "waveforms");
  ({ GET: clipThumbGET } = (await import("../src/app/api/clips/[id]/thumbnail/route")) as unknown as {
    GET: Handler;
  });
  ({ GET: waveformGET } = (await import("../src/app/api/projects/[id]/waveform/route")) as unknown as {
    GET: Handler;
  });
  ({ DELETE: clipDELETE } = (await import("../src/app/api/clips/[id]/route")) as unknown as {
    DELETE: Handler;
  });
  ({ DELETE: projectDELETE } = (await import("../src/app/api/projects/[id]/route")) as unknown as {
    DELETE: Handler;
  });
});

afterAll(() => {
  testDb.close();
  rmSync(derivedDir, { recursive: true, force: true });
  delete process.env.SSECLONE_DB_PATH;
  delete process.env.SSECLONE_CLIP_THUMB_DIR;
  delete process.env.SSECLONE_WAVEFORM_DIR;
});

beforeEach(() => {
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

describe("GET /api/clips/:id/thumbnail", () => {
  it("streams the clip poster as a JPEG", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    writeDerived(clipThumbnailPath(clipId), "poster-bytes");

    const res = await clipThumbGET(new Request(`http://x/api/clips/${clipId}/thumbnail`), ctx(String(clipId)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(await res.text()).toBe("poster-bytes");
  });

  it("404s cleanly before the poster exists, and for a missing clip", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    const notYet = await clipThumbGET(new Request("http://x"), ctx(String(clipId)));
    expect(notYet.status).toBe(404);
    expect(((await notYet.json()) as { code: string }).code).toBe("no_thumbnail");

    const missing = await clipThumbGET(new Request("http://x"), ctx("9999"));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");
  });

  it("400s a malformed id", async () => {
    const res = await clipThumbGET(new Request("http://x"), ctx("abc"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/:id/waveform", () => {
  it("streams the waveform as a PNG", async () => {
    const projectId = seedProject();
    writeDerived(waveformPath(projectId), "png-bytes");

    const res = await waveformGET(new Request("http://x"), ctx(String(projectId)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("png-bytes");
  });

  it("404s cleanly for a no-audio project with no waveform", async () => {
    const projectId = seedProject();
    const res = await waveformGET(new Request("http://x"), ctx(String(projectId)));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("no_waveform");
  });
});

describe("cascade removes derived files", () => {
  it("unlinks the clip poster when the clip is deleted", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    const thumb = clipThumbnailPath(clipId);
    writeDerived(thumb);
    expect(existsSync(thumb)).toBe(true);

    const res = await clipDELETE(new Request("http://x", { method: "DELETE" }), ctx(String(clipId)));
    expect(res.status).toBe(200);
    expect(existsSync(thumb)).toBe(false);
  });

  it("unlinks clip posters and the waveform when the project is deleted", async () => {
    const projectId = seedProject();
    const clipId = seedClip(projectId);
    const thumb = clipThumbnailPath(clipId);
    const wave = waveformPath(projectId);
    writeDerived(thumb);
    writeDerived(wave);

    const res = await projectDELETE(new Request("http://x", { method: "DELETE" }), ctx(String(projectId)));
    expect(res.status).toBe(200);
    expect(existsSync(thumb)).toBe(false);
    expect(existsSync(wave)).toBe(false);
  });
});
