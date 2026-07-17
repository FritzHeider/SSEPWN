import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CaptionDoc } from "../src/lib/captions/ass";
import { clipEdits, clips, projects, transcripts } from "../src/lib/db/schema";
import type { TranscriptSegment } from "../src/lib/transcribe/types";
import { createTestDb, type TestDb } from "./helpers/db";

type ParamHandler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

let captionsPATCH: ParamHandler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patch(id: string, body: unknown, raw = false): Promise<Response> {
  return captionsPATCH(
    new Request(`http://localhost/api/clips/${id}/captions`, {
      method: "PATCH",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

const SEGMENTS: TranscriptSegment[] = [
  {
    text: "the quick brown fox",
    start: 0,
    end: 4,
    words: [
      { word: "the", start: 0, end: 1 },
      { word: "quick", start: 1, end: 2 },
      { word: "brown", start: 2, end: 3 },
      { word: "fox", start: 3, end: 4 },
    ],
  },
];

function seedProjectWithClip(): { clipId: number; transcriptId: number } {
  const [project] = testDb.db
    .insert(projects)
    .values({ name: "cap project", sourceVideoPath: "/tmp/x.mp4", duration: 10 })
    .returning({ id: projects.id })
    .all();
  const [transcript] = testDb.db
    .insert(transcripts)
    .values({ projectId: project.id, segments: JSON.stringify(SEGMENTS) })
    .returning({ id: transcripts.id })
    .all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return { clipId: clip.id, transcriptId: transcript.id };
}

function storedCaptions(clipId: number): CaptionDoc | null {
  const row = testDb.db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  if (!row) return null;
  return (JSON.parse(row.state) as { captions: CaptionDoc }).captions;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ PATCH: captionsPATCH } = (await import(
    "../src/app/api/clips/[id]/captions/route"
  )) as unknown as { PATCH: ParamHandler });
});

afterEach(() => {
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(transcripts).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("PATCH /api/clips/:id/captions", () => {
  it("builds the caption doc from the transcript on first edit and persists it — without altering transcripts", async () => {
    const { clipId } = seedProjectWithClip();
    const before = testDb.db.select().from(transcripts).all();

    const res = await patch(String(clipId), { op: "set-word", line: 0, word: 0, text: "THE!" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clipId: number; captions: CaptionDoc };
    expect(body.clipId).toBe(clipId);
    expect(body.captions.cues[0].lines[0].words[0].text).toBe("THE!");

    // Persisted to clip_edits.
    const stored = storedCaptions(clipId);
    expect(stored?.cues[0].lines[0].words[0].text).toBe("THE!");

    // The transcript row is byte-for-byte unchanged (clip-local isolation).
    const after = testDb.db.select().from(transcripts).all();
    expect(after).toEqual(before);
    expect(after[0].segments).toBe(JSON.stringify(SEGMENTS));
  });

  it("reads the stored doc on subsequent edits (edits accumulate)", async () => {
    const { clipId } = seedProjectWithClip();
    await patch(String(clipId), { op: "set-style", style: { preset: "boxed" } });
    const res = await patch(String(clipId), { op: "set-word", line: 0, word: 1, text: "SLOW" });
    expect(res.status).toBe(200);

    const stored = storedCaptions(clipId);
    // Style change from the first edit survived the second.
    expect(stored?.style.box).toBe(true);
    expect(stored?.name).toBe("boxed");
    // Word change from the second edit applied.
    expect(stored?.cues[0].lines[0].words[1].text).toBe("SLOW");
    // Exactly one clip_edits row (updated in place, not duplicated).
    expect(testDb.db.select().from(clipEdits).where(eq(clipEdits.clipId, clipId)).all()).toHaveLength(
      1,
    );
  });

  it("404s for a missing clip, without creating a clip_edits row", async () => {
    const res = await patch("999", { op: "merge-line", line: 0 });
    expect(res.status).toBe(404);
    expect(testDb.db.select().from(clipEdits).all()).toHaveLength(0);
  });

  it("400s for a malformed edit body", async () => {
    const { clipId } = seedProjectWithClip();
    expect((await patch(String(clipId), { op: "bogus" })).status).toBe(400);
    expect((await patch(String(clipId), "not json", true)).status).toBe(400);
    // No document was persisted for a rejected edit.
    expect(storedCaptions(clipId)).toBeNull();
  });

  it("400s for an in-range op that points at a non-existent line", async () => {
    const { clipId } = seedProjectWithClip();
    const res = await patch(String(clipId), { op: "set-word", line: 99, word: 0, text: "x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_edit");
  });
});
