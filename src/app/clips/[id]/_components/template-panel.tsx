"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  PLATFORM_PRESET_LIST,
  maxLengthWarning,
  resolvePresetSelection,
  type PlatformPresetId,
} from "@/lib/presets";
import type { Template } from "@/lib/templates/types";

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const sel =
  "rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950";

/** A small colour chip labelling one of a template's brand colours. */
function Swatch({ color, title }: { color: string; title: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-black/10 dark:border-white/20"
      style={{ backgroundColor: color }}
      title={`${title} ${color}`}
      aria-label={`${title} ${color}`}
    />
  );
}

/** One template card: name, brand swatches, caption preset + aspect ratio badges,
 * a CTA count, and an Apply button. The applied template is ring-highlighted. */
function TemplateCard({
  template,
  applied,
  busy,
  onApply,
}: {
  template: Template;
  applied: boolean;
  busy: boolean;
  onApply: () => void;
}) {
  return (
    <li
      data-testid="template-card"
      data-template-id={template.id}
      data-applied={applied}
      className={`flex flex-col gap-2 rounded-lg border p-3 text-xs ${
        applied
          ? "border-emerald-500 ring-1 ring-emerald-500/40"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-800 dark:text-zinc-100">{template.name}</span>
        {template.builtin ? (
          <span className="rounded bg-zinc-100 px-1 font-mono uppercase text-[10px] text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            built-in
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
        <Swatch color={template.brandPrimary} title="Primary" />
        <Swatch color={template.brandSecondary} title="Secondary" />
        <span className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-900">{template.aspectRatio}</span>
        <span className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">{template.captionPreset}</span>
        {template.ctas.length > 0 ? (
          <span className="text-zinc-400">
            {template.ctas.length} CTA{template.ctas.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="apply-template"
        className={`${btn} self-start`}
        disabled={busy}
        onClick={onApply}
      >
        {applied ? "Re-apply" : "Apply"}
      </button>
    </li>
  );
}

/**
 * Template gallery + platform-preset picker (Phase 09).
 *
 * The gallery lists built-in and saved templates with visual style swatches;
 * Apply POSTs `apply-template` (which may enqueue a smart-crop server-side) and
 * refreshes the editor. "Save current look" POSTs `save-as-template` from the
 * clip's live edit state; Undo DELETEs the last application. The preset picker
 * PUTs the per-clip override and shows a max-length warning badge computed from
 * the clip's window duration against the *effective* preset (per-clip override
 * layered over the project default) using the same pure helpers as the export
 * pipeline — no client-side re-implementation of the rules.
 */
export function TemplatePanel({
  clipId,
  templates,
  appliedTemplateId,
  canUndo,
  durationSec,
  presetOverride,
  projectPreset,
}: {
  clipId: number;
  templates: Template[];
  appliedTemplateId: number | null;
  canUndo: boolean;
  durationSec: number;
  presetOverride: PlatformPresetId | null;
  projectPreset: PlatformPresetId | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { preset: effective, source } = resolvePresetSelection(presetOverride, projectPreset);
  const warning = maxLengthWarning(effective, durationSec);

  /** Run a mutating request, then refresh the server component so the editor
   * reflects the new applied template / preset / crop job. */
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

  const apply = (templateId: number) =>
    run(() =>
      fetch(`/api/clips/${clipId}/apply-template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId }),
      }),
    );

  const undo = () =>
    run(() => fetch(`/api/clips/${clipId}/apply-template`, { method: "DELETE" }));

  const saveAsTemplate = () => {
    const name = window.prompt("Name this template", "My template");
    if (name === null) return;
    void run(() =>
      fetch(`/api/clips/${clipId}/save-as-template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  };

  const selectPreset = (value: string) => {
    const platformPreset = value === "" ? null : (value as PlatformPresetId);
    void run(() =>
      fetch(`/api/clips/${clipId}/preset`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platformPreset }),
      }),
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Templates and platform preset">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Preset
        </span>
        <select
          className={sel}
          data-testid="preset-select"
          aria-label="Platform preset"
          value={presetOverride ?? ""}
          disabled={busy}
          onChange={(e) => selectPreset(e.target.value)}
        >
          <option value="">
            Inherit ({resolvePresetSelection(null, projectPreset).preset.label})
          </option>
          {PLATFORM_PRESET_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="text-zinc-400">
          {effective.label} · {effective.aspectRatio}
          {source !== "clip" ? " (inherited)" : ""}
        </span>
        {warning ? (
          <span
            data-testid="maxlen-badge"
            className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
          >
            ⚠ {warning}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Templates
        </span>
        <button type="button" className={btn} disabled={busy} onClick={saveAsTemplate}>
          Save current look…
        </button>
        <button
          type="button"
          data-testid="undo-template"
          className={btn}
          disabled={busy || !canUndo}
          onClick={undo}
        >
          Undo apply
        </button>
        <a href="/templates" className="text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          Manage
        </a>
        {error ? <span className="text-red-600 dark:text-red-400">{error}</span> : null}
      </div>

      {templates.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              applied={t.id === appliedTemplateId}
              busy={busy}
              onApply={() => apply(t.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No templates yet.</p>
      )}
    </section>
  );
}
