import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProjectWorkspace } from "./_components/project-workspace";
import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { listClips } from "@/lib/projects/clips";
import { readTranscript } from "@/lib/projects/transcript";
import { formatDuration, formatResolution, statusBadge, EMPTY } from "@/lib/projects/view";

// Reads the projects and transcripts tables per request; nothing here is static.
export const dynamic = "force-dynamic";

/**
 * `/projects/:id` — the source video with its transcript beside it.
 *
 * Reads the DB directly instead of fetching its own API, matching `/`'s
 * server-rendered first paint: an HTTP round trip to our own process would add a
 * hop and a way to fail without buying anything the route does not already
 * guarantee here.
 *
 * A malformed id and an unknown id both become `notFound()`. The transcript API
 * distinguishes them (400 vs 404) because a client needs to know whether to fix
 * its request, but a person who typed a bad URL has one thing to learn from both
 * — there is no page here — and Next has exactly one way to say it.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) notFound();

  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) notFound();

  // Non-null: readTranscript and listClips return null only when the project is
  // absent, and the select above already proved it is not.
  const transcript = readTranscript(db, id)!;
  const clips = listClips(db, id)!;

  const badge = statusBadge(project);
  const duration = formatDuration(project.duration);
  const resolution = formatResolution(project.width, project.height);

  return (
    <div className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← Projects
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {project.name}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {badge.label}
            {duration === EMPTY && resolution === EMPTY ? "" : ` · ${duration} · ${resolution}`}
          </p>
          {badge.detail ? (
            <p className="text-sm text-red-700 dark:text-red-400">{badge.detail}</p>
          ) : null}
        </header>

        <ProjectWorkspace
          projectId={id}
          duration={project.duration}
          transcript={transcript}
          initialClips={clips}
        />
      </main>
    </div>
  );
}
