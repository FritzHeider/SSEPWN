"use client";

import { Loader2, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "./toaster";
import { useHomeEvents } from "./use-home-events";
import { formatRate, transferredLabel, uploadPercent } from "@/lib/projects/format";
import { reinsert, removeById, type Removed } from "@/lib/projects/pending-delete";
import {
  EMPTY,
  formatDuration,
  formatResolution,
  hasPendingWork,
  projectCountsLabel,
  shouldShowThumbnail,
  statusBadge,
  thumbnailUrl,
  type BadgeTone,
  type ProjectView,
} from "@/lib/projects/view";
import { allowedExtensions, fileInputAccept, isAcceptedVideoFile } from "@/lib/upload/allowed";

/** Fallback poll cadence, used only if the SSE stream errors out. */
const POLL_INTERVAL_MS = 1500;
/** How long a deleted row can be undone before the DELETE actually fires. */
const UNDO_MS = 5000;

const TONE_CLASSES: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-[var(--surface-overlay)] text-[var(--text-muted)]",
  progress: "bg-[color-mix(in_oklab,var(--timeline)_18%,transparent)] text-[var(--timeline)]",
  success: "bg-[color-mix(in_oklab,var(--success)_18%,transparent)] text-[var(--success)]",
  danger: "bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] text-[var(--danger)]",
};

/** Live upload progress while an XHR POST is in flight. */
interface UploadState {
  loaded: number;
  total: number;
  rate: number;
}

export function ProjectsPanel({ initialProjects }: { initialProjects: ProjectView[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const { toast } = useToast();
  const pendingRef = useRef(
    new Map<number, { timeout: ReturnType<typeof setTimeout>; removed: Removed<ProjectView> }>(),
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) return;
      const body = (await response.json()) as { projects: ProjectView[] };
      // Drop any row with a delete still pending its undo window, so the server's
      // (still-present) copy does not visually resurrect a row the user removed.
      const pending = pendingRef.current;
      setProjects(pending.size ? body.projects.filter((p) => !pending.has(p.id)) : body.projects);
    } catch {
      // A dropped refetch is not worth showing; the next event or poll retries.
    }
  }, []);

  // Live updates via SSE; fall back to the old interval poll only if it errors
  // and only while something is still expected to change.
  const { failed } = useHomeEvents(refresh);
  useEffect(() => {
    if (!failed || !hasPendingWork(projects)) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [failed, projects, refresh]);

  // ── Undoable deletes ───────────────────────────────────────────────────────
  const commitDelete = useCallback(async (id: number) => {
    const entry = pendingRef.current.get(id);
    pendingRef.current.delete(id);
    try {
      const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      if (entry) setProjects((current) => reinsert(current, entry.removed));
      toast({ title: "Delete failed", description: "The project was restored.", variant: "danger" });
    }
  }, [toast]);

  const undoDelete = useCallback((id: number) => {
    const entry = pendingRef.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pendingRef.current.delete(id);
    setProjects((current) => reinsert(current, entry.removed));
  }, []);

  const remove = useCallback(
    (project: ProjectView) => {
      const { list, removed } = removeById(projects, project.id);
      if (!removed) return;
      setProjects(list);
      const timeout = setTimeout(() => void commitDelete(project.id), UNDO_MS);
      pendingRef.current.set(project.id, { timeout, removed });
      toast({
        title: `Deleted ${project.name}`,
        description: "Removes its clips, exports and files.",
        durationMs: UNDO_MS,
        action: { label: "Undo", onClick: () => undoDelete(project.id) },
      });
    },
    [projects, commitDelete, undoDelete, toast],
  );

  // Flush pending deletes when leaving — a full unload (pagehide, keepalive so it
  // survives navigation) and an SPA unmount both commit rather than lose them.
  useEffect(() => {
    const pending = pendingRef.current;
    const flush = () => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        void fetch(`/api/projects/${id}`, { method: "DELETE", keepalive: true });
      }
      pending.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // ── Upload (XHR for real progress) ─────────────────────────────────────────
  const startUpload = useCallback(
    (file: File) => {
      // Client-side gate only — src/lib/upload/receive.ts re-checks on the server.
      if (!isAcceptedVideoFile(file)) {
        setError(`"${file.name}" is not a supported video. Allowed: ${allowedExtensions().join(", ")}`);
        return;
      }
      setError(null);
      setUpload({ loaded: 0, total: file.size, rate: 0 });

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      const startedAt = performance.now();

      xhr.upload.onprogress = (event) => {
        const elapsed = (performance.now() - startedAt) / 1000;
        const total = event.lengthComputable ? event.total : file.size;
        setUpload({ loaded: event.loaded, total, rate: elapsed > 0 ? event.loaded / elapsed : 0 });
      };
      xhr.onload = () => {
        xhrRef.current = null;
        setUpload(null);
        if (xhr.status >= 200 && xhr.status < 300) {
          void refresh();
          return;
        }
        // The API answers 4xx with { error, code }; surface its message.
        let message = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* non-JSON body — keep the status fallback */
        }
        setError(message);
      };
      xhr.onerror = () => {
        xhrRef.current = null;
        setUpload(null);
        setError("Upload failed — is the server still running?");
      };
      xhr.onabort = () => {
        xhrRef.current = null;
        setUpload(null);
      };

      const form = new FormData();
      form.append("file", file);
      xhr.open("POST", "/api/projects");
      xhr.send(form);
    },
    [refresh],
  );

  const cancelUpload = useCallback(() => xhrRef.current?.abort(), []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (upload) return;
      const file = event.dataTransfer.files?.[0];
      if (file) startUpload(file);
    },
    [startUpload, upload],
  );

  return (
    <div className="flex w-full flex-col gap-8">
      <section>
        {upload ? (
          <UploadProgress state={upload} onCancel={cancelUpload} />
        ) : (
          <div
            role="button"
            tabIndex={0}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              dragging
                ? "border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]"
                : "border-[var(--border-subtle)] hover:border-[var(--text-muted)]"
            }`}
          >
            <Upload className="h-6 w-6 text-[var(--text-muted)]" aria-hidden />
            <p className="text-base font-medium text-[var(--text)]">Drop a video here, or click to choose</p>
            <p className="text-sm text-[var(--text-muted)]">{allowedExtensions().join(", ")} · up to 2 GB</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={fileInputAccept()}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) startUpload(file);
            event.target.value = "";
          }}
        />

        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Projects</h2>
        {projects.length === 0 ? (
          <p className="rounded-lg border border-[var(--border-subtle)] p-6 text-sm text-[var(--text-muted)]">
            No projects yet. Upload a video to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} onDelete={remove} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UploadProgress({ state, onCancel }: { state: UploadState; onCancel: () => void }) {
  const percent = uploadPercent(state.loaded, state.total);
  const rate = formatRate(state.rate);
  return (
    <div
      data-testid="upload-progress"
      className="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" aria-hidden />
        <span className="text-sm font-medium text-[var(--text)]">Uploading… {percent}%</span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-overlay)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Cancel
        </button>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-[var(--surface-overlay)]"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-[var(--timeline)] transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <p className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
        {transferredLabel(state.loaded, state.total)}
        {rate ? ` · ${rate}` : ""}
      </p>
    </div>
  );
}

function ProjectRow({ project, onDelete }: { project: ProjectView; onDelete: (project: ProjectView) => void }) {
  const badge = statusBadge(project);
  const duration = formatDuration(project.duration);
  const resolution = formatResolution(project.width, project.height);

  return (
    <li className="flex items-center gap-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 transition-colors hover:border-[var(--text-muted)]">
      <Poster project={project} />
      <div className="flex min-w-0 flex-col gap-1">
        {/* The name is the link, not the whole row: an overlay would swallow the
            text selection people use to copy a filename. */}
        <Link
          href={`/projects/${project.id}`}
          className="truncate font-medium text-[var(--text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {project.name}
        </Link>
        <span className="text-sm text-[var(--text-muted)]">
          {duration === EMPTY && resolution === EMPTY ? "Probing…" : `${duration} · ${resolution}`}
        </span>
        {project.clipCount > 0 ? (
          <span className="text-sm text-[var(--text-muted)]">{projectCountsLabel(project)}</span>
        ) : null}
        {badge.detail ? <span className="text-sm text-[var(--danger)]">{badge.detail}</span> : null}
      </div>
      <span className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[badge.tone]}`}>
        {badge.label}
      </span>
      <button
        type="button"
        onClick={() => onDelete(project)}
        aria-label={`Delete ${project.name}`}
        className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] hover:text-[var(--danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

function Poster({ project }: { project: ProjectView }) {
  const [broken, setBroken] = useState(false);
  const show = shouldShowThumbnail(project) && !broken;

  if (!show) {
    return <div className="h-10 w-16 shrink-0 rounded bg-[var(--surface-overlay)]" aria-hidden />;
  }

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
