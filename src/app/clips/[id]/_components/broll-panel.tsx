"use client";

import { useState } from "react";

import { formatDuration } from "@/lib/projects/view";
import {
  addBroll,
  listBroll,
  removeBroll,
  updateBroll,
  type BrollSlot,
} from "@/lib/timeline/broll";
import type { TimelineDoc } from "@/lib/timeline/types";
import { AssetPicker } from "./asset-picker";

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const num =
  "w-16 rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-right font-mono text-xs tabular-nums dark:border-zinc-700";

/** A labelled number input that commits through a pure op on change. */
function Field({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
      {label}
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(3))}
        onChange={(e) => onCommit(Number(e.target.value))}
        className={num}
        aria-label={label}
      />
    </label>
  );
}

/** One row: range, mode, pip geometry and removal for a single slot. Every
 * control commits through a pure `broll` op against the live `doc`. */
function BrollRow({
  doc,
  slot,
  onRun,
}: {
  doc: TimelineDoc;
  slot: BrollSlot;
  onRun: (op: () => TimelineDoc) => void;
}) {
  const patch = (p: Parameters<typeof updateBroll>[2]) => onRun(() => updateBroll(doc, slot.id, p));
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800"
      data-testid="broll-row"
      data-broll-id={slot.id}
      data-broll-mode={slot.mode}
    >
      <span className="font-mono text-zinc-500 dark:text-zinc-400">#{slot.assetId}</span>
      <Field label="in" value={slot.start} step={0.1} onCommit={(v) => patch({ start: v })} />
      <Field label="out" value={slot.end} step={0.1} onCommit={(v) => patch({ end: v })} />
      <button
        type="button"
        className={btn}
        aria-pressed={slot.mode === "full"}
        onClick={() => patch({ mode: slot.mode === "pip" ? "full" : "pip" })}
      >
        {slot.mode === "pip" ? "PiP" : "Full"}
      </button>
      {slot.mode === "pip" ? (
        <>
          <Field label="x" value={slot.pip.x} step={0.05} onCommit={(v) => patch({ pip: { x: v } })} />
          <Field label="y" value={slot.pip.y} step={0.05} onCommit={(v) => patch({ pip: { y: v } })} />
          <Field label="scale" value={slot.pip.scale} step={0.05} onCommit={(v) => patch({ pip: { scale: v } })} />
        </>
      ) : null}
      <button type="button" className={btn} onClick={() => onRun(() => removeBroll(doc, slot.id))}>
        Remove
      </button>
    </li>
  );
}

/**
 * B-roll editor (Phase 08): insert a B-roll asset at the playhead from the
 * shared picker, then move/resize its range, switch pip/full, reposition the pip
 * box, or remove it. All edits go through the pure `lib/timeline/broll` ops via
 * `onRun` (the timeline panel's error-catching committer), so this holds no
 * range or geometry arithmetic of its own.
 */
export function BrollPanel({
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
  const slots = listBroll(doc);

  return (
    <section className="flex flex-col gap-2" aria-label="B-roll">
      <div className="flex items-center gap-3 text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">B-roll</span>
        <button type="button" className={btn} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          {picking ? "Close" : "Add at playhead"}
        </button>
        <span className="font-mono tabular-nums text-zinc-400">@ {formatDuration(playhead)}</span>
      </div>

      {picking ? (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <AssetPicker
            projectId={projectId}
            kind="video"
            onSelect={(asset) => {
              onRun(() => addBroll(doc, { assetId: asset.id, start: playhead }));
              setPicking(false);
            }}
          />
        </div>
      ) : null}

      {slots.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {slots.map((slot) => (
            <BrollRow key={slot.id} doc={doc} slot={slot} onRun={onRun} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No B-roll yet.</p>
      )}
    </section>
  );
}
