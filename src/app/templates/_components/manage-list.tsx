"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Template } from "@/lib/templates/types";

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-black/10 dark:border-white/20"
      style={{ backgroundColor: color }}
      title={color}
    />
  );
}

/** One manage row: swatches + AR/preset badges, then rename/delete for saved
 * templates or a lock note for built-ins (which are undeletable per SPEC). */
function Row({
  template,
  busy,
  onRename,
  onDelete,
}: {
  template: Template;
  busy: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      data-testid="manage-row"
      data-template-id={template.id}
      data-builtin={template.builtin}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
    >
      <span className="min-w-40 flex-1 font-medium text-zinc-800 dark:text-zinc-100">
        {template.name}
      </span>
      <span className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <Swatch color={template.brandPrimary} />
        <Swatch color={template.brandSecondary} />
        <span className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-900">{template.aspectRatio}</span>
        <span className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">{template.captionPreset}</span>
      </span>
      {template.builtin ? (
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          built-in
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <button type="button" data-testid="rename-template" className={btn} disabled={busy} onClick={onRename}>
            Rename
          </button>
          <button type="button" data-testid="delete-template" className={btn} disabled={busy} onClick={onDelete}>
            Delete
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * The template manage list (Phase 09). Renders every template; built-ins are
 * shown read-only (locked), saved templates get Rename (PATCH) and Delete
 * (DELETE) which refresh the server component on success. All mutation rules
 * (built-in protection) are enforced server-side too — this UI only hides the
 * controls.
 */
export function ManageList({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(req: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      const res = await req();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  const rename = (t: Template) => {
    const name = window.prompt("Rename template", t.name);
    if (name === null || name.trim() === "") return;
    void run(() =>
      fetch(`/api/templates/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  };

  const remove = (t: Template) => {
    if (!window.confirm(`Delete "${t.name}"? This cannot be undone.`)) return;
    void run(() => fetch(`/api/templates/${t.id}`, { method: "DELETE" }));
  };

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {templates.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {templates.map((t) => (
            <Row
              key={t.id}
              template={t}
              busy={busy}
              onRename={() => rename(t)}
              onDelete={() => remove(t)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No templates yet.</p>
      )}
    </div>
  );
}
