import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { jobs, projects } from "../src/lib/db/schema";
import { createJobQueue } from "../src/lib/jobs";
import { createTestDb, type TestDb } from "./helpers/db";

type ListHandler = () => Promise<Response>;
type ItemHandler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let listProjects: ListHandler;
let getProject: ItemHandler;
let getJob: ItemHandler;
let testDb: TestDb;

/** Next 16 hands dynamic routes their params as a promise. */
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(url: string): Request {
  return new Request(`http://localhost${url}`);
}

interface ProjectBody {
  id: number;
  name: string;
  status: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  thumbnailPath: string | null;
  error: string | null;
  createdAt: number;
}

interface JobBody {
  id: number;
  projectId: number;
  type: string;
  status: string;
  progress: number;
  payload: unknown;
  attempts: number;
}

beforeAll(async () => {
  testDb = createTestDb();
  // The routes import the db singleton, which opens its file at import time —
  // point it at the migrated test db before that import happens.
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: listProjects } = (await import("../src/app/api/projects/route")) as unknown as { GET: ListHandler });
  ({ GET: getProject } = (await import("../src/app/api/projects/[id]/route")) as unknown as { GET: ItemHandler });
  ({ GET: getJob } = (await import("../src/app/api/jobs/[id]/route")) as unknown as { GET: ItemHandler });
});

afterEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/projects", () => {
  it("returns an empty list when there are no projects", async () => {
    const response = await listProjects();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
  });

  it("serves the metadata the list UI renders", async () => {
    testDb.db
      .insert(projects)
      .values({
        name: "podcast.mp4",
        sourceVideoPath: "/uploads/abc.mp4",
        status: "ready",
        duration: 5.2,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        thumbnailPath: "/uploads/abc.jpg",
      })
      .run();

    const body = (await (await listProjects()).json()) as { projects: ProjectBody[] };

    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      name: "podcast.mp4",
      status: "ready",
      duration: 5.2,
      width: 1280,
      height: 720,
      hasAudio: true,
      thumbnailPath: "/uploads/abc.jpg",
    });
  });

  it("carries the failure reason so the list can render a failed badge", async () => {
    testDb.db.insert(projects).values({ name: "broken.mp4", status: "failed", error: "not a readable video file" }).run();

    const body = (await (await listProjects()).json()) as { projects: ProjectBody[] };

    expect(body.projects[0]).toMatchObject({ status: "failed", error: "not a readable video file" });
  });

  it("orders projects newest first", async () => {
    // Distinct created_at values: the ordinary case.
    testDb.db.insert(projects).values({ name: "oldest", createdAt: 1000 }).run();
    testDb.db.insert(projects).values({ name: "middle", createdAt: 2000 }).run();
    testDb.db.insert(projects).values({ name: "newest", createdAt: 3000 }).run();

    const body = (await (await listProjects()).json()) as { projects: ProjectBody[] };

    expect(body.projects.map((p) => p.name)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks created_at ties by id so the polled list never shuffles", async () => {
    // created_at is unixepoch SECONDS, so uploads within the same second share
    // a timestamp. Without an id tiebreak SQLite may return these in any order
    // and the auto-refreshing list would reshuffle between polls. Insertion
    // order is deliberately NOT the expected order — a mutant that drops the
    // ORDER BY and falls back to rowid scan order returns first→last and fails.
    testDb.db.insert(projects).values({ name: "first", createdAt: 1700 }).run();
    testDb.db.insert(projects).values({ name: "second", createdAt: 1700 }).run();
    testDb.db.insert(projects).values({ name: "third", createdAt: 1700 }).run();

    const body = (await (await listProjects()).json()) as { projects: ProjectBody[] };

    expect(body.projects.map((p) => p.name)).toEqual(["third", "second", "first"]);
  });
});

describe("GET /api/projects/:id", () => {
  it("returns the project with the progress of its jobs", async () => {
    const [project] = testDb.db.insert(projects).values({ name: "podcast.mp4", status: "uploaded" }).returning().all();
    const queue = createJobQueue(testDb.db);
    const job = queue.enqueue("ingest", project.id, { path: "/uploads/abc.mp4" });
    queue.updateProgress(job.id, 42);

    const response = await getProject(request(`/api/projects/${project.id}`), ctx(String(project.id)));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { project: ProjectBody; jobs: JobBody[] };
    expect(body.project).toMatchObject({ id: project.id, name: "podcast.mp4", status: "uploaded" });
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ id: job.id, type: "ingest", status: "queued", progress: 42 });
    // Parsed, not the raw JSON string the column holds.
    expect(body.jobs[0].payload).toEqual({ path: "/uploads/abc.mp4" });
  });

  it("returns only that project's jobs", async () => {
    // A single-project fixture would pass even if the route ignored the id and
    // returned every job in the table, so both projects have jobs here.
    const [mine] = testDb.db.insert(projects).values({ name: "mine" }).returning().all();
    const [other] = testDb.db.insert(projects).values({ name: "other" }).returning().all();
    const queue = createJobQueue(testDb.db);
    queue.enqueue("ingest", mine.id);
    queue.enqueue("ingest", other.id);
    queue.enqueue("transcribe", other.id);

    const body = (await (await getProject(request("/x"), ctx(String(mine.id)))).json()) as { jobs: JobBody[] };

    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].projectId).toBe(mine.id);
  });

  it("lists a project's jobs oldest first", async () => {
    const [project] = testDb.db.insert(projects).values({ name: "podcast.mp4" }).returning().all();
    const queue = createJobQueue(testDb.db);
    queue.enqueue("ingest", project.id);
    queue.enqueue("transcribe", project.id);

    const body = (await (await getProject(request("/x"), ctx(String(project.id)))).json()) as { jobs: JobBody[] };

    expect(body.jobs.map((j) => j.type)).toEqual(["ingest", "transcribe"]);
  });

  it("returns an empty job list for a project that has none", async () => {
    const [project] = testDb.db.insert(projects).values({ name: "no jobs" }).returning().all();

    const response = await getProject(request("/x"), ctx(String(project.id)));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { jobs: JobBody[] }).jobs).toEqual([]);
  });

  it("404s on a project that does not exist", async () => {
    const response = await getProject(request("/api/projects/9999"), ctx("9999"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
  });

  it("400s on an id that is not a positive integer", async () => {
    // Without a boundary check these coerce to NaN and become a misleading 404
    // (or a 500) rather than telling the client what it got wrong.
    for (const bad of ["abc", "1.5", "-1", "0", "", " 1 ", "1e3", "0x0c", "1; DROP TABLE projects"]) {
      const response = await getProject(request("/x"), ctx(bad));

      expect(response.status, `id ${JSON.stringify(bad)} should be rejected`).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_id");
    }
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns the job's status, progress and error", async () => {
    const [project] = testDb.db.insert(projects).values({ name: "podcast.mp4" }).returning().all();
    const queue = createJobQueue(testDb.db);
    const job = queue.enqueue("ingest", project.id, { path: "/uploads/abc.mp4" });
    queue.updateProgress(job.id, 75);

    const response = await getJob(request(`/api/jobs/${job.id}`), ctx(String(job.id)));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: JobBody };
    expect(body.job).toMatchObject({
      id: job.id,
      projectId: project.id,
      type: "ingest",
      status: "queued",
      progress: 75,
      attempts: 0,
    });
    expect(body.job.payload).toEqual({ path: "/uploads/abc.mp4" });
  });

  it("reports a failed job's error", async () => {
    const [project] = testDb.db.insert(projects).values({ name: "broken.mp4" }).returning().all();
    const queue = createJobQueue(testDb.db, { maxAttempts: 1 });
    const job = queue.enqueue("ingest", project.id);
    queue.claimNext();
    queue.fail(job.id, new Error("not a readable video file"));

    const body = (await (await getJob(request("/x"), ctx(String(job.id)))).json()) as {
      job: JobBody & { error: string };
    };

    expect(body.job).toMatchObject({ status: "failed", error: "not a readable video file" });
  });

  it("404s on a job that does not exist", async () => {
    const response = await getJob(request("/api/jobs/9999"), ctx("9999"));

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
  });

  it("400s on an id that is not a positive integer", async () => {
    const response = await getJob(request("/x"), ctx("abc"));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_id");
  });
});
