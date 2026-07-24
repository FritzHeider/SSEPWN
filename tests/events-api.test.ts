import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clips, jobs, projects } from "../src/lib/db/schema";
import { createJobQueue } from "../src/lib/jobs";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request) => Promise<Response>;

let eventsGET: Handler;
let testDb: TestDb;

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: eventsGET } = (await import("../src/app/api/events/route")) as unknown as { GET: Handler });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

function seedProject(): number {
  const [row] = testDb.db.insert(projects).values({ name: "p", status: "ready" }).returning({ id: projects.id }).all();
  return row.id;
}

/**
 * Open the stream, read until the accumulated text satisfies `done`, then abort
 * so the route's poll/keepalive intervals are torn down and the test can exit.
 */
async function readStream(url: string, done: (text: string) => boolean): Promise<{ status: number; text: string; response: Response }> {
  const controller = new AbortController();
  const response = await eventsGET(new Request(url, { signal: controller.signal }));
  if (!response.body) return { status: response.status, text: "", response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2000;
  try {
    while (!done(text) && Date.now() < deadline) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return { status: response.status, text, response };
}

describe("GET /api/events", () => {
  it("400s a malformed projectId and 404s a missing project", async () => {
    const bad = await eventsGET(new Request("http://x/api/events?projectId=abc"));
    expect(bad.status).toBe(400);
    await bad.body?.cancel();
    const missing = await eventsGET(new Request("http://x/api/events?projectId=9999"));
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  });

  it("sends a retry hint and an initial snapshot with all sections for a project", async () => {
    const projectId = seedProject();
    createJobQueue(testDb.db).enqueue("ingest", projectId);
    testDb.db.insert(clips).values({ projectId, inPoint: 0, outPoint: 4, status: "candidate", title: "c" }).run();

    const { status, text, response } = await readStream(
      `http://x/api/events?projectId=${projectId}`,
      (t) => t.includes("event: snapshot"),
    );
    expect(status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(text).toContain("retry:");
    expect(text).toContain("event: snapshot");

    const dataLine = text.split("\n").find((l) => l.startsWith("data: "))!;
    const snapshot = JSON.parse(dataLine.slice("data: ".length)) as {
      jobs: unknown[];
      clips: { title: string }[];
      exports: unknown[];
    };
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.clips).toHaveLength(1);
    expect(snapshot.clips[0].title).toBe("c");
    expect(Array.isArray(snapshot.exports)).toBe(true);
  });

  it("streams a projects snapshot for the home list (no projectId)", async () => {
    seedProject();
    const { text } = await readStream("http://x/api/events", (t) => t.includes("event: snapshot"));
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "))!;
    const snapshot = JSON.parse(dataLine.slice("data: ".length)) as { projects: unknown[] };
    expect(snapshot.projects).toHaveLength(1);
  });
});
