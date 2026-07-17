import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects, transcripts } from "../src/lib/db/schema";
import type { TranscriptSegment } from "../src/lib/transcribe/types";
import { NO_AUDIO_NOTE } from "../src/worker/handlers/transcribe";
import { createTestDb, type TestDb } from "./helpers/db";

type ItemHandler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getTranscript: ItemHandler;
let testDb: TestDb;

/** Next 16 hands dynamic routes their params as a promise. */
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return getTranscript(new Request(`http://localhost/api/projects/${id}/transcript`), ctx(id));
}

interface TranscriptBody {
  projectId: number;
  transcribed: boolean;
  statusNote: string | null;
  segments: TranscriptSegment[];
}

function segment(text: string, start: number, end: number): TranscriptSegment {
  return {
    text,
    start,
    end,
    words: [{ word: text.split(" ")[0], start, end: start + 0.2 }],
  };
}

function seed(name: string, values: Partial<typeof projects.$inferInsert> = {}): number {
  const [row] = testDb.db.insert(projects).values({ name, ...values }).returning({ id: projects.id }).all();
  return row.id;
}

function seedTranscript(projectId: number, segments: TranscriptSegment[]) {
  testDb.db.insert(transcripts).values({ projectId, segments: JSON.stringify(segments) }).run();
}

beforeAll(async () => {
  testDb = createTestDb();
  // The route imports the db singleton, which opens its file at import time —
  // point it at the migrated test db before that import happens.
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: getTranscript } = (await import("../src/app/api/projects/[id]/transcript/route")) as unknown as {
    GET: ItemHandler;
  });
});

afterEach(() => {
  testDb.db.delete(transcripts).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/projects/:id/transcript", () => {
  it("returns the segments with word timings, parsed rather than as a JSON string", async () => {
    const written = [segment("Here's the secret.", 1.5, 3.25)];
    const id = seed("has transcript", { transcribed: true, hasAudio: true });
    seedTranscript(id, written);

    const response = await get(String(id));
    const body = (await response.json()) as TranscriptBody;

    expect(response.status).toBe(200);
    // U2: the column is TEXT. A route that forwards it raw hands back a string
    // where the type promises TranscriptSegment[] — and `typeof body.segments`
    // would still be "string", which a truthiness check happily accepts.
    expect(Array.isArray(body.segments)).toBe(true);
    expect(body.segments).toEqual(written);
    expect(body.segments[0].words[0]).toEqual({ word: "Here's", start: 1.5, end: 1.7 });
    expect(body.transcribed).toBe(true);
    expect(body.statusNote).toBeNull();
  });

  // U1, first half: the no-transcript case is a successful read of nothing, not
  // a 404. A 404 here would make "no captions, and here's why" indistinguishable
  // from a bad URL, which is the whole reason statusNote exists.
  it("returns 200 with an empty transcript and the reason for a no-audio project", async () => {
    const id = seed("silent film", { hasAudio: false, transcribed: false, statusNote: NO_AUDIO_NOTE });

    const response = await get(String(id));
    const body = (await response.json()) as TranscriptBody;

    expect(response.status).toBe(200);
    expect(body.segments).toEqual([]);
    expect(body.transcribed).toBe(false);
    expect(body.statusNote).toBe(NO_AUDIO_NOTE);
  });

  it("returns 200 with an empty transcript for a project whose transcribe job has not run", async () => {
    const id = seed("still processing", { hasAudio: true });

    const response = await get(String(id));
    const body = (await response.json()) as TranscriptBody;

    expect(response.status).toBe(200);
    expect(body.segments).toEqual([]);
    expect(body.transcribed).toBe(false);
    expect(body.statusNote).toBeNull();
  });

  // U1, second half: without this, a route that 200s absolutely everything
  // passes the two cases above.
  it("returns 404 for a project that does not exist", async () => {
    const response = await get("4321");
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(404);
    expect(body.code).toBe("not_found");
    expect(body.error).toContain("4321");
  });

  // U4: parseId's 400-vs-404 distinction. A route that skips parseId turns a
  // malformed id into a misleading "no such project".
  it.each(["abc", "0", "-1", "1.0", "1e3", " 1 ", ""])("returns 400 invalid_id for %j", async (raw) => {
    const response = await get(raw);
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe("invalid_id");
  });

  // U3: two projects, different transcripts, each must own its content.
  it("returns the transcript of the requested project, not of another one", async () => {
    const first = seed("first", { transcribed: true, hasAudio: true });
    const second = seed("second", { transcribed: true, hasAudio: true });
    seedTranscript(first, [segment("First project speaking.", 0, 2)]);
    seedTranscript(second, [segment("Second project speaking.", 0, 2)]);

    const firstBody = (await (await get(String(first))).json()) as TranscriptBody;
    const secondBody = (await (await get(String(second))).json()) as TranscriptBody;

    expect(firstBody.projectId).toBe(first);
    expect(firstBody.segments[0].text).toBe("First project speaking.");
    expect(secondBody.projectId).toBe(second);
    expect(secondBody.segments[0].text).toBe("Second project speaking.");
  });

  // U5: the handler replaces rather than appends, so two rows should not happen —
  // but if one ever survives, the answer must be deterministic rather than
  // whichever row SQLite reaches for first.
  it("returns the newest transcript when a stale row survives", async () => {
    const id = seed("re-transcribed", { transcribed: true, hasAudio: true });
    seedTranscript(id, [segment("Stale text.", 0, 1)]);
    seedTranscript(id, [segment("Fresh text.", 0, 1)]);

    const body = (await (await get(String(id))).json()) as TranscriptBody;

    expect(body.segments).toHaveLength(1);
    expect(body.segments[0].text).toBe("Fresh text.");
  });
});
