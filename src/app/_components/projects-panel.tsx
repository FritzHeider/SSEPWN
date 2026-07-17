"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  EMPTY,
  formatDuration,
  formatResolution,
  hasPendingWork,
  shouldShowThumbnail,
  statusBadge,
  thumbnailUrl,
  type BadgeTone,
  type ProjectView,
} from "@/lib/projects/view";
import { allowedExtensions, fileInputAccept, isAcceptedVideoFile } from "@/lib/upload/allowed";

/** How often to re-read the list while an ingest is still in flight. */
const POLL_INTERVAL_MS = 1500;

const TONE_CLASSES: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  progress: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function ProjectsPanel({ initialProjects }: { initialProjects: ProjectView[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) return;
      const body = (await response.json()) as { projects: ProjectView[] };
      setProjects(body.projects);
    } catch {
      // A dropped poll is not worth showing the user; the next tick retries.
    }
  }, []);

  // Poll only while something is still expected to change. An all-settled list
  // has nothing to refresh for, and idle timers are the kind of thing that
  // quietly burns a laptop battery.
  useEffect(() => {
    if (!hasPendingWork(projects)) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [projects, refresh]);

  const upload = useCallback(
    async (file: File) => {
      // Fast client-side feedback only — src/lib/upload/receive.ts re-checks this
      // on the server, where the client cannot lie about it.
      if (!isAcceptedVideoFile(file)) {
        setError(`"${file.name}" is not a supported video. Allowed: ${allowedExtensions().join(", ")}`);
        return;
      }

      setError(null);
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/projects", { method: "POST", body: form });

        if (!response.ok) {
          // The API answers 400 with { error, code } for every client-caused
          // rejection; show its message rather than inventing a worse one.
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `Upload failed (${response.status})`);
          return;
        }
        await refresh();
      } catch {
        setError("Upload failed — is the server still running?");
      } finally {
        setUploading(false);
      }
    },
    [refresh],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void upload(file);
    },
    [upload],
  );

  return (
    <div className="flex w-full flex-col gap-8">
      <section>
        <div
          onDragOver={(event) => {
            // Without preventDefault the browser navigates to the dropped file.
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
            dragging
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
              : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600"
          }`}
        >
          <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            {uploading ? "Uploading…" : "Drop a video here, or click to choose"}
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{allowedExtensions().join(", ")} · up to 2 GB</p>
          <input
            ref={fileInputRef}
            type="file"
            accept={fileInputAccept()}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              // Reset so re-picking the same file fires change again.
              event.target.value = "";
            }}
          />
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Projects
        </h2>
        {projects.length === 0 ? (
          <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            No projects yet. Upload a video to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectView }) {
  const badge = statusBadge(project);
  const duration = formatDuration(project.duration);
  const resolution = formatResolution(project.width, project.height);

  return (
    <li className="flex items-center gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <Poster project={project} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{project.name}</span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {duration === EMPTY && resolution === EMPTY ? "Probing…" : `${duration} · ${resolution}`}
        </span>
        {badge.detail ? (
          <span className="text-sm text-red-700 dark:text-red-400">{badge.detail}</span>
        ) : null}
      </div>
      <span
        className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[badge.tone]}`}
      >
        {badge.label}
      </span>
    </li>
  );
}

function Poster({ project }: { project: ProjectView }) {
  // The row tells us whether a poster exists; the route 404s cleanly when it
  // does not (DEC-004). onError still guards the narrow race where the file is
  // deleted between the poll and the image load.
  const [broken, setBroken] = useState(false);
  const show = shouldShowThumbnail(project) && !broken;

  if (!show) {
    return <div className="h-10 w-16 shrink-0 rounded bg-zinc-100 dark:bg-zinc-800" aria-hidden />;
  }

  // A plain <img>, not next/image: the poster is already generated at display
  // size by the ingest handler, so there is nothing for the optimizer to do, and
  // next/image gives no way to fall back when the route 404s mid-ingest.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={thumbnailUrl(project.id)}
      alt=""
      width={64}
      height={40}
      onError={() => setBroken(true)}
      className="h-10 w-16 shrink-0 rounded object-cover"
    />
  );
}
