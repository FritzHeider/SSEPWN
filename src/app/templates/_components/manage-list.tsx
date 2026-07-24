"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { TemplateThumb } from "@/app/clips/[id]/_components/template-thumb";
import type { Template } from "@/lib/templates/types";

const btn =
  "cursor-pointer rounded-md border border-border-subtle px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-border-subtle"
      style={{ backgroundColor: color }}
      title={color}
    />
  );
}

/** One manage row: a live style thumbnail + swatches + AR/preset badges, then
 * rename/delete for saved templates or a lock note for built-ins. */
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
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle p-3 text-sm"
    >
      <TemplateThumb style={template.captionStyle} className="shrink-0" />
      <span className="min-w-40 flex-1 font-medium text-text">{template.name}</span>
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        <Swatch color={template.brandPrimary} />
        <Swatch color={template.brandSecondary} />
        <span className="rounded bg-surface-overlay px-1 font-mono">{template.aspectRatio}</span>
        <span className="rounded bg-surface-overlay px-1">{template.captionPreset}</span>
      </span>
      {template.builtin ? (
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-muted">
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
 * The template manage list (Phase 09): every template with a live style preview;
 * built-ins are read-only, saved templates get Rename (PATCH) and Delete (DELETE),
 * both refreshing the server component on success. Built-in protection is enforced
 * server-side too — this UI only hides the controls.
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
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {templates.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {templates.map((t) => (
            <Row key={t.id} template={t} busy={busy} onRename={() => rename(t)} onDelete={() => remove(t)} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted">No templates yet.</p>
      )}
    </div>
  );
}
