import { ProjectsPanel } from "./_components/projects-panel";
import { listProjects } from "@/lib/projects/queries";

// Reads the projects table per request; nothing here is static.
export const dynamic = "force-dynamic";

export default function Home() {
  // Server-render the first paint so the list never flashes empty before the
  // client's first SSE snapshot. `ProjectsPanel` takes it from here.
  const projects = listProjects();

  return (
    <div className="flex flex-1 justify-center px-6 py-12">
      <main className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">Projects</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Upload a video to turn it into short vertical clips.
          </p>
        </header>
        <ProjectsPanel initialProjects={projects} />
      </main>
    </div>
  );
}
