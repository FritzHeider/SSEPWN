import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips, exports, jobs, projects } from "@/lib/db/schema";
import {
  diffHomeSnapshot,
  diffProjectSnapshot,
  formatSseFrame,
  snapshotFrame,
  type HomeSnapshot,
  type ProjectSnapshot,
  type SseFrame,
} from "@/lib/events/snapshot";
import { createJobQueue } from "@/lib/jobs";
import { listProjects } from "@/lib/projects/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the server re-reads the DB and emits deltas. */
const POLL_MS = 1000;
/** Keepalive comment cadence — keeps proxies from closing an idle stream. */
const KEEPALIVE_MS = 15_000;

/** The project's live jobs/clips/exports, as the diff module consumes them. */
function buildProjectSnapshot(projectId: number): ProjectSnapshot {
  const jobRows = createJobQueue(db).listByProject(projectId);
  const clipRows = db
    .select({
      id: clips.id,
      title: clips.title,
      inPoint: clips.inPoint,
      outPoint: clips.outPoint,
      status: clips.status,
    })
    .from(clips)
    .where(eq(clips.projectId, projectId))
    .orderBy(asc(clips.id))
    .all();

  // Export progress is resolved exactly as GET /api/exports/:id resolves it: a
  // done row pins to 100, otherwise the linked render job's live progress (0
  // before it is claimed). The left join carries that progress in one query.
  const exportRows = db
    .select({
      id: exports.id,
      clipId: exports.clipId,
      status: exports.status,
      jobProgress: jobs.progress,
    })
    .from(exports)
    .innerJoin(clips, eq(exports.clipId, clips.id))
    .leftJoin(jobs, eq(exports.jobId, jobs.id))
    .where(eq(clips.projectId, projectId))
    .orderBy(asc(exports.id))
    .all();

  return {
    jobs: jobRows.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      progress: job.progress,
      updatedAt: job.updatedAt,
    })),
    clips: clipRows,
    exports: exportRows.map((row) => ({
      id: row.id,
      clipId: row.clipId,
      status: row.status,
      progress: row.status === "done" ? 100 : row.jobProgress ?? 0,
    })),
  };
}

/** The dashboard's project summaries, for the home stream (no projectId). */
function buildHomeSnapshot(): HomeSnapshot {
  return {
    projects: listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      clipCount: Number(project.clipCount),
      exportCount: Number(project.exportCount),
    })),
  };
}

/**
 * GET /api/events?projectId=N — a Server-Sent Events stream of live state.
 *
 * With a `projectId`, emits `jobs` / `clips` / `exports` events whenever the
 * project's rows change; without one, emits `projects` for the home list. On
 * connect it sends one `snapshot` event carrying every section (the client's
 * baseline), a `retry:` hint, and thereafter only the sections that changed,
 * polling every second. A `: keepalive` comment every 15s keeps proxies from
 * dropping an idle connection. The poll timer is torn down when the request
 * aborts or the stream is cancelled, so a disconnected client leaks nothing.
 *
 * All the "what changed" logic lives in the pure `src/lib/events` module; this
 * route is only DB reads + transport, and each poll is wrapped so a transient
 * read error logs rather than tearing the stream down.
 */
export async function GET(request: Request) {
  const projectIdRaw = new URL(request.url).searchParams.get("projectId");
  let projectId: number | null = null;
  if (projectIdRaw !== null) {
    projectId = parseId(projectIdRaw);
    if (projectId === null) {
      return NextResponse.json(
        { error: "projectId must be a positive integer", code: "invalid_id" },
        { status: 400 },
      );
    }
    const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
    if (!project) {
      return NextResponse.json({ error: `No project with id ${projectId}`, code: "not_found" }, { status: 404 });
    }
  }

  const encoder = new TextEncoder();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // Captured across ticks; typed loosely because the two modes carry different
  // snapshot shapes and each tick only ever compares like with like.
  let prevProject: ProjectSnapshot | null = null;
  let prevHome: HomeSnapshot | null = null;

  // Set on teardown; a timer tick can land in the window between the client
  // disconnecting and its cleanup running, and enqueue on a closed controller
  // throws ERR_INVALID_STATE — the writer checks the flag instead.
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const writeFrames = (frames: SseFrame[]) => {
        for (const frame of frames) write(formatSseFrame(frame));
      };

      // Reconnect hint + initial full-baseline snapshot.
      write(`retry: ${POLL_MS * 3}\n\n`);
      if (projectId !== null) {
        prevProject = buildProjectSnapshot(projectId);
        write(formatSseFrame(snapshotFrame(prevProject)));
      } else {
        prevHome = buildHomeSnapshot();
        write(formatSseFrame(snapshotFrame(prevHome)));
      }

      const cleanup = () => {
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        pollTimer = null;
        keepaliveTimer = null;
        try {
          controller.close();
        } catch {
          // Already closed by a cancelled response — nothing to do.
        }
      };

      pollTimer = setInterval(() => {
        try {
          if (projectId !== null) {
            const next = buildProjectSnapshot(projectId);
            writeFrames(diffProjectSnapshot(prevProject, next));
            prevProject = next;
          } else {
            const next = buildHomeSnapshot();
            writeFrames(diffHomeSnapshot(prevHome, next));
            prevHome = next;
          }
        } catch (error) {
          // A transient DB read must not tear the stream down; the next tick retries.
          console.error("[events] poll failed:", error);
        }
      }, POLL_MS);

      keepaliveTimer = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);

      // The request aborting (client navigated away) is the primary teardown path.
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
