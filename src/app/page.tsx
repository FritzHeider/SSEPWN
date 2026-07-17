import { ProjectsPanel } from "./_components/projects-panel";
import { listProjects } from "@/lib/projects/queries";

// Reads the projects table per request; nothing here is static.
export const dynamic = "force-dynamic";

export default function Home() {
  // Server-render the first paint so the list never flashes empty before the
  // client's first poll. `ProjectsPanel` takes it from here.
  const projects = listProjects();

  return (
    <div className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Sseclone
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Upload a video to turn it into short vertical clips.
          </p>
        </header>
        <ProjectsPanel initialProjects={projects} />
      </main>
    </div>
  );
}
