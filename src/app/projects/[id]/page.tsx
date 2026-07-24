import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProjectWorkspace } from "./_components/project-workspace";
import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import { derivePipeline } from "@/lib/pipeline";
import { listClips } from "@/lib/projects/clips";
import { clipGenerationComplete } from "@/lib/projects/retry";
import { readTranscript } from "@/lib/projects/transcript";
import { EMPTY, formatDuration, formatResolution, statusBadge } from "@/lib/projects/view";

// Reads the projects and transcripts tables per request; nothing here is static.
export const dynamic = "force-dynamic";

/**
 * `/projects/:id` — the source video with its transcript beside it, both driven
 * live by the SSE stream once mounted. This server render seeds the first paint:
 * the clip list, the transcript, and the initial pipeline steps (re-derived
 * client-side from job events afterward). A malformed or unknown id is 404.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) notFound();

  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) notFound();

  // Non-null: both return null only when the project is absent, already ruled out.
  const transcript = readTranscript(db, id)!;
  const clips = listClips(db, id)!;

  const badge = statusBadge(project);
  const duration = formatDuration(project.duration);
  const resolution = formatResolution(project.width, project.height);

  const jobs = createJobQueue(db).listByProject(id);
  const initialSteps = derivePipeline({
    jobs: jobs.map((job) => ({ type: job.type, status: job.status, error: job.error })),
    projectStatus: project.status,
    hasAudio: project.hasAudio,
    transcribed: project.transcribed,
    clipCount: clips.length,
  });
  const generationComplete = clipGenerationComplete(jobs);

  return (
    <div className="flex flex-1 justify-center px-6 py-12">
      <main className="flex w-full max-w-3xl flex-col gap-8 xl:max-w-7xl">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            ← Projects
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">{project.name}</h1>
          <p className="text-sm text-[var(--text-muted)]">
            {badge.label}
            {duration === EMPTY && resolution === EMPTY ? "" : ` · ${duration} · ${resolution}`}
          </p>
          {badge.detail ? <p className="text-sm text-[var(--danger)]">{badge.detail}</p> : null}
        </header>

        <ProjectWorkspace
          projectId={id}
          duration={project.duration}
          hasAudio={project.hasAudio}
          projectStatus={project.status}
          transcribed={project.transcribed}
          initialGenerationComplete={generationComplete}
          initialSteps={initialSteps}
          transcript={transcript}
          initialClips={clips}
        />
      </main>
    </div>
  );
}
