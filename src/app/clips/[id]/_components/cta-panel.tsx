"use client";

import { useState } from "react";

import { formatDuration } from "@/lib/projects/view";
import {
  addCta,
  addCtaPreset,
  CTA_ANIMS,
  CTA_POSITIONS,
  CTA_PRESETS,
  listCta,
  removeCta,
  updateCta,
  type CtaAnim,
  type CtaOverlay,
  type CtaPosition,
} from "@/lib/timeline/cta";
import type { TimelineDoc } from "@/lib/timeline/types";
import { AssetPicker } from "./asset-picker";

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const num =
  "w-16 rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-right font-mono text-xs tabular-nums dark:border-zinc-700";
const sel =
  "rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950";

/** A labelled number input that commits through a pure op on change. */
function NumField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
      {label}
      <input
        type="number"
        step={0.1}
        value={Number(value.toFixed(3))}
        onChange={(e) => onCommit(Number(e.target.value))}
        className={num}
        aria-label={label}
      />
    </label>
  );
}

/** One CTA row: content/image, anchor, animations, range and removal. Every
 * control commits through a pure `cta` op against the live `doc`. */
function CtaRow({
  doc,
  cta,
  onRun,
}: {
  doc: TimelineDoc;
  cta: CtaOverlay;
  onRun: (op: () => TimelineDoc) => void;
}) {
  const patch = (p: Parameters<typeof updateCta>[2]) => onRun(() => updateCta(doc, cta.id, p));
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800"
      data-testid="cta-row"
      data-cta-id={cta.id}
      data-cta-variant={cta.variant}
    >
      <span className="rounded bg-zinc-100 px-1 font-mono uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
        {cta.variant}
      </span>
      {cta.variant === "text" ? (
        <input
          key={cta.id}
          type="text"
          defaultValue={cta.content}
          onBlur={(e) => {
            if (e.target.value.trim() !== "") patch({ content: e.target.value });
          }}
          className="min-w-32 flex-1 rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700"
          aria-label="CTA text"
        />
      ) : (
        <span className="font-mono text-zinc-500 dark:text-zinc-400">#{cta.assetId}</span>
      )}
      <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        pos
        <select
          className={sel}
          value={cta.position}
          onChange={(e) => patch({ position: e.target.value as CtaPosition })}
          aria-label="CTA position"
        >
          {CTA_POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        in
        <select
          className={sel}
          value={cta.animIn}
          onChange={(e) => patch({ animIn: e.target.value as CtaAnim })}
          aria-label="CTA anim in"
        >
          {CTA_ANIMS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        out
        <select
          className={sel}
          value={cta.animOut}
          onChange={(e) => patch({ animOut: e.target.value as CtaAnim })}
          aria-label="CTA anim out"
        >
          {CTA_ANIMS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <NumField label="from" value={cta.start} onCommit={(v) => patch({ start: v })} />
      <NumField label="to" value={cta.end} onCommit={(v) => patch({ end: v })} />
      <button type="button" className={btn} onClick={() => onRun(() => removeCta(doc, cta.id))}>
        Remove
      </button>
    </li>
  );
}

/**
 * CTA overlay editor (Phase 08): drop a built-in text preset or a blank text card
 * at the playhead, or pick an image asset for an image CTA, then edit each
 * overlay's text, 9-grid anchor, in/out animation and range. All edits go through
 * the pure `lib/timeline/cta` ops via `onRun` (the timeline panel's error-catching
 * committer); the animated DOM preview is `<CtaPreview>`.
 */
export function CtaPanel({
  doc,
  projectId,
  playhead,
  onRun,
}: {
  doc: TimelineDoc;
  projectId: number;
  playhead: number;
  onRun: (op: () => TimelineDoc) => void;
}) {
  const [picking, setPicking] = useState(false);
  const ctas = listCta(doc);

  return (
    <section className="flex flex-col gap-2" aria-label="CTA overlays">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">CTA</span>
        {CTA_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={btn}
            onClick={() => onRun(() => addCtaPreset(doc, preset.id, { start: playhead }))}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          className={btn}
          onClick={() => onRun(() => addCta(doc, { variant: "text", content: "New CTA", start: playhead }))}
        >
          + Text
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => setPicking((p) => !p)}
          aria-expanded={picking}
        >
          {picking ? "Close" : "+ Image"}
        </button>
        <span className="font-mono tabular-nums text-zinc-400">@ {formatDuration(playhead)}</span>
      </div>

      {picking ? (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <AssetPicker
            projectId={projectId}
            kind="image"
            onSelect={(asset) => {
              onRun(() => addCta(doc, { variant: "image", assetId: asset.id, start: playhead }));
              setPicking(false);
            }}
          />
        </div>
      ) : null}

      {ctas.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {ctas.map((cta) => (
            <CtaRow key={cta.id} doc={doc} cta={cta} onRun={onRun} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No CTA overlays yet.</p>
      )}
    </section>
  );
}
