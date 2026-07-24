import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clipEdits, clips, projects, transcripts } from "../src/lib/db/schema";
import type { TranscriptSegment } from "../src/lib/transcribe/types";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let srtGET: Handler;
let vttGET: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** A one-segment transcript with two words inside the clip window [0, 4]. */
function transcript(): TranscriptSegment[] {
  return [
    {
      text: "hello world",
      start: 0,
      end: 2,
      words: [
        { word: "hello", start: 0.0, end: 1.0 },
        { word: "world", start: 1.0, end: 2.0 },
      ],
    },
  ];
}

function seedClipWithTranscript(title: string): number {
  const [project] = testDb.db.insert(projects).values({ name: "p" }).returning({ id: projects.id }).all();
  testDb.db.insert(transcripts).values({ projectId: project.id, segments: JSON.stringify(transcript()) }).run();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title })
    .returning({ id: clips.id })
    .all();
  return clip.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: srtGET } = (await import("../src/app/api/clips/[id]/captions/srt/route")) as unknown as {
    GET: Handler;
  });
  ({ GET: vttGET } = (await import("../src/app/api/clips/[id]/captions/vtt/route")) as unknown as {
    GET: Handler;
  });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(transcripts).run();
  testDb.db.delete(projects).run();
});

describe("GET /api/clips/:id/captions/srt", () => {
  it("serves SubRip built from the transcript with a slugged filename", async () => {
    const id = seedClipWithTranscript("My Great Clip");
    const res = await srtGET(new Request("http://x"), ctx(String(id)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('filename="my-great-clip.srt"');
    const body = await res.text();
    expect(body).toContain("hello world");
    expect(body).toMatch(/00:00:00,000 --> /);
  });

  it("404s a missing clip and 400s a bad id", async () => {
    expect((await srtGET(new Request("http://x"), ctx("9999"))).status).toBe(404);
    expect((await srtGET(new Request("http://x"), ctx("abc"))).status).toBe(400);
  });
});

describe("GET /api/clips/:id/captions/vtt", () => {
  it("serves WebVTT with the header and a slugged filename", async () => {
    const id = seedClipWithTranscript("Reels Minimal");
    const res = await vttGET(new Request("http://x"), ctx(String(id)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('filename="reels-minimal.vtt"');
    const body = await res.text();
    expect(body.startsWith("WEBVTT")).toBe(true);
    expect(body).toMatch(/00:00:00\.000 --> /);
  });

  it("falls back to `clip` for an untitled clip", async () => {
    const id = seedClipWithTranscript("");
    const res = await vttGET(new Request("http://x"), ctx(String(id)));
    expect(res.headers.get("content-disposition")).toContain('filename="clip.vtt"');
  });
});
