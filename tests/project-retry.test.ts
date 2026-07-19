import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { jobs, projects } from "../src/lib/db/schema";
import { createJobQueue, type Job } from "../src/lib/jobs";
import { clipGenerationComplete, findFailedStep, retryPipeline } from "../src/lib/projects/retry";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let projectRetryPOST: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function post(id: string): Promise<Response> {
  return projectRetryPOST(new Request(`http://localhost/api/projects/${id}/retry`, { method: "POST" }), ctx(id));
}

/** A project row with a chosen status. */
function seedProject(status: string): number {
  const [row] = testDb.db
    .insert(projects)
    .values({ name: `${status} project`, status, error: status === "failed" ? "boom" : null })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

/** Insert a job row directly so its terminal status is exactly what a test wants. */
function seedJob(projectId: number, type: string, status: string, payload?: unknown): void {
  testDb.db
    .insert(jobs)
    .values({
      projectId,
      type,
      status,
      payload: payload === undefined ? null : JSON.stringify(payload),
    })
    .run();
}

function jobsFor(projectId: number): Job[] {
  return createJobQueue(testDb.db).listByProject(projectId);
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ POST: projectRetryPOST } = (await import("../src/app/api/projects/[id]/retry/route")) as unknown as {
    POST: Handler;
  });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(projects).run();
});

afterEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(projects).run();
});

describe("findFailedStep", () => {
  function job(type: string, status: string): Job {
    return {
      id: 1,
      projectId: 1,
      type,
      status: status as Job["status"],
      progress: 0,
      error: null,
      payload: null,
      attempts: 3,
      maxAttempts: 3,
      runAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  it("returns null when no pipeline job has failed", () => {
    expect(findFailedStep([job("ingest", "done"), job("transcribe", "running")])).toBeNull();
  });

  it("picks the earliest failed step in chain order, not insertion order", () => {
    const found = findFailedStep([job("generate-clips", "failed"), job("ingest", "failed")]);
    expect(found?.type).toBe("ingest");
  });

  it("ignores failed jobs that are not part of the auto pipeline", () => {
    expect(findFailedStep([job("export", "failed"), job("smart-crop", "failed")])).toBeNull();
  });

  describe("clipGenerationComplete", () => {
    it("is true once a generate-clips job has finished", () => {
      expect(clipGenerationComplete([job("ingest", "done"), job("generate-clips", "done")])).toBe(true);
    });

    it("is false while generation is still queued, running, or failed", () => {
      expect(clipGenerationComplete([job("generate-clips", "running")])).toBe(false);
      expect(clipGenerationComplete([job("generate-clips", "failed")])).toBe(false);
    });

    it("is false before generation is even enqueued", () => {
      expect(clipGenerationComplete([job("ingest", "done"), job("transcribe", "running")])).toBe(false);
    });
  });
});

describe("retryPipeline", () => {
  it("requeues a failed ingest, preserving its payload and clearing the failed project", () => {
    const projectId = seedProject("failed");
    seedJob(projectId, "ingest", "failed", { path: "data/uploads/x.mp4" });

    const result = retryPipeline(testDb.db, projectId);

    expect(result.retried).toBe(true);
    expect(result.job?.type).toBe("ingest");
    expect(result.job?.status).toBe("queued");
    // Payload survives so the requeued ingest points at the same upload.
    expect(result.job?.payload).toEqual({ path: "data/uploads/x.mp4" });

    const project = testDb.db.select().from(projects).where(eq(projects.id, projectId)).get();
    expect(project?.status).toBe("uploaded");
    expect(project?.error).toBeNull();

    // The dead row stays; a brand-new queued job joins it.
    const all = jobsFor(projectId);
    expect(all.filter((j) => j.type === "ingest").map((j) => j.status).sort()).toEqual(["failed", "queued"]);
  });

  it("requeues a failed generate-clips without touching a still-ready project", () => {
    const projectId = seedProject("ready");
    seedJob(projectId, "ingest", "done");
    seedJob(projectId, "transcribe", "done");
    seedJob(projectId, "generate-clips", "failed");

    const result = retryPipeline(testDb.db, projectId);

    expect(result.retried).toBe(true);
    expect(result.job?.type).toBe("generate-clips");
    // Transcribe/generate-clips never mark the project failed, so nothing resets.
    const project = testDb.db.select().from(projects).where(eq(projects.id, projectId)).get();
    expect(project?.status).toBe("ready");
  });

  it("returns no_failed_step when the chain has not failed", () => {
    const projectId = seedProject("ready");
    seedJob(projectId, "ingest", "done");

    expect(retryPipeline(testDb.db, projectId)).toEqual({ retried: false, reason: "no_failed_step" });
  });

  it("returns project_not_found for an unknown project", () => {
    expect(retryPipeline(testDb.db, 9999)).toEqual({ retried: false, reason: "project_not_found" });
  });
});

describe("POST /api/projects/:id/retry", () => {
  it("400s a malformed id", async () => {
    const res = await post("abc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });

  it("404s an unknown project", async () => {
    const res = await post("4242");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("409s a project whose pipeline has not failed", async () => {
    const projectId = seedProject("ready");
    seedJob(projectId, "ingest", "done");

    const res = await post(String(projectId));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("no_failed_step");
  });

  it("200s and enqueues a fresh job for the failed step", async () => {
    const projectId = seedProject("failed");
    seedJob(projectId, "ingest", "failed", { path: "data/uploads/y.mp4" });

    const res = await post(String(projectId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retried: boolean; job: { type: string; status: string } };
    expect(body.retried).toBe(true);
    expect(body.job.type).toBe("ingest");
    expect(body.job.status).toBe("queued");

    const queued = jobsFor(projectId).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
  });
});
