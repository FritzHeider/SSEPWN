"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { TemplateThumb } from "./template-thumb";
import {
  PLATFORM_PRESET_LIST,
  maxLengthWarning,
  resolvePresetSelection,
  type PlatformPresetId,
} from "@/lib/presets";
import type { Template } from "@/lib/templates/types";

const btn =
  "cursor-pointer rounded-md border border-border-subtle px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const sel =
  "rounded border border-border-subtle bg-surface-raised px-1.5 py-1 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A small colour chip labelling one of a template's brand colours. */
function Swatch({ color, title }: { color: string; title: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-border-subtle"
      style={{ backgroundColor: color }}
      title={`${title} ${color}`}
      aria-label={`${title} ${color}`}
    />
  );
}

/** One template card: a live 9:16 style thumbnail, name, brand swatches, caption
 * preset + aspect ratio badges, a CTA count, and an Apply button. The applied
 * template gets an accent ring + Check badge. */
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
      className={`relative flex gap-3 rounded-lg border p-3 text-xs ${
        applied ? "border-accent ring-1 ring-accent" : "border-border-subtle"
      }`}
    >
      {applied ? (
        <span
          className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-contrast"
          data-testid="template-applied-badge"
        >
          <Check className="h-3 w-3" aria-hidden />
          Applied
        </span>
      ) : null}
      <TemplateThumb style={template.captionStyle} className="shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-text">{template.name}</span>
          {template.builtin ? (
            <span className="rounded bg-surface-overlay px-1 font-mono text-[10px] uppercase text-text-muted">
              built-in
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-text-muted">
          <Swatch color={template.brandPrimary} title="Primary" />
          <Swatch color={template.brandSecondary} title="Secondary" />
          <span className="rounded bg-surface-overlay px-1 font-mono">{template.aspectRatio}</span>
          <span className="rounded bg-surface-overlay px-1">{template.captionPreset}</span>
          {template.ctas.length > 0 ? (
            <span>
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
      </div>
    </li>
  );
}

/**
 * Template gallery + platform-preset picker (Phase 09). Each card previews the
 * template's caption look with a live style thumbnail (item 27); Apply POSTs
 * `apply-template` and refreshes the editor. The preset picker PUTs the per-clip
 * override and shows a max-length warning badge computed from the clip window
 * against the effective preset using the same pure helpers as the export pipeline.
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

  const undo = () => run(() => fetch(`/api/clips/${clipId}/apply-template`, { method: "DELETE" }));

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
        <span className="font-semibold uppercase tracking-wide text-text-muted">Preset</span>
        <select
          className={sel}
          data-testid="preset-select"
          aria-label="Platform preset"
          value={presetOverride ?? ""}
          disabled={busy}
          onChange={(e) => selectPreset(e.target.value)}
        >
          <option value="">Inherit ({resolvePresetSelection(null, projectPreset).preset.label})</option>
          {PLATFORM_PRESET_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="text-text-muted">
          {effective.label} · {effective.aspectRatio}
          {source !== "clip" ? " (inherited)" : ""}
        </span>
        {warning ? (
          <span
            data-testid="maxlen-badge"
            className="rounded bg-accent/15 px-1.5 py-0.5 font-medium text-accent"
          >
            ⚠ {warning}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-text-muted">Templates</span>
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
        <a
          href="/templates"
          className="rounded text-text-muted underline transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Manage
        </a>
        {error ? <span className="text-danger">{error}</span> : null}
      </div>

      {templates.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
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
        <p className="text-xs text-text-muted">No templates yet.</p>
      )}
    </section>
  );
}
