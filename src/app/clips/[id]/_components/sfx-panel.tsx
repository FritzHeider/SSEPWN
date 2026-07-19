"use client";

import { useState } from "react";

import { formatDuration } from "@/lib/projects/view";
import {
  addSfx,
  listSfx,
  removeSfx,
  updateSfx,
  SFX_MAX_VOLUME,
  type SfxCue,
} from "@/lib/timeline/sfx";
import type { TimelineDoc } from "@/lib/timeline/types";
import { AssetPicker } from "./asset-picker";

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const num =
  "w-16 rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-right font-mono text-xs tabular-nums dark:border-zinc-700";

/** One SFX cue row: nudge its time, set volume, toggle main-audio ducking, remove.
 * Every control commits through a pure `sfx` op against the live `doc`. */
function SfxRow({
  doc,
  cue,
  onRun,
}: {
  doc: TimelineDoc;
  cue: SfxCue;
  onRun: (op: () => TimelineDoc) => void;
}) {
  const patch = (p: Parameters<typeof updateSfx>[2]) => onRun(() => updateSfx(doc, cue.id, p));
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800"
      data-testid="sfx-row"
      data-sfx-id={cue.id}
      data-sfx-duck={cue.duckMain ? "on" : "off"}
    >
      <span className="font-mono text-zinc-500 dark:text-zinc-400">#{cue.assetId}</span>
      <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        at
        <input
          type="number"
          step={0.1}
          value={Number(cue.t.toFixed(3))}
          onChange={(e) => patch({ t: Number(e.target.value) })}
          className={num}
          aria-label="SFX time"
        />
      </label>
      <label className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        vol
        <input
          type="range"
          min={0}
          max={SFX_MAX_VOLUME}
          step={0.05}
          value={cue.volume}
          onChange={(e) => patch({ volume: Number(e.target.value) })}
          aria-label="SFX volume"
          className="w-24"
        />
        <span className="w-8 text-right font-mono tabular-nums text-zinc-400">
          {Math.round(cue.volume * 100)}%
        </span>
      </label>
      <button
        type="button"
        className={btn}
        aria-pressed={cue.duckMain}
        onClick={() => patch({ duckMain: !cue.duckMain })}
      >
        {cue.duckMain ? "Duck: on" : "Duck: off"}
      </button>
      <button type="button" className={btn} onClick={() => onRun(() => removeSfx(doc, cue.id))}>
        Remove
      </button>
    </li>
  );
}

/**
 * Sound-effect editor (Phase 08): place an audio asset from the shared picker at
 * the playhead, then nudge its time, set its volume, toggle whether it ducks the
 * main track, or remove it. All edits go through the pure `lib/timeline/sfx` ops
 * via `onRun` (the timeline panel's error-catching committer); the WebAudio preview
 * is `<SfxPreview>`.
 */
export function SfxPanel({
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
  const cues = listSfx(doc);

  return (
    <section className="flex flex-col gap-2" aria-label="Sound effects">
      <div className="flex items-center gap-3 text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">SFX</span>
        <button type="button" className={btn} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          {picking ? "Close" : "Add at playhead"}
        </button>
        <span className="font-mono tabular-nums text-zinc-400">@ {formatDuration(playhead)}</span>
      </div>

      {picking ? (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <AssetPicker
            projectId={projectId}
            kind="audio"
            onSelect={(asset) => {
              onRun(() => addSfx(doc, { assetId: asset.id, t: playhead }));
              setPicking(false);
            }}
          />
        </div>
      ) : null}

      {cues.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {cues.map((cue) => (
            <SfxRow key={cue.id} doc={doc} cue={cue} onRun={onRun} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No sound effects yet.</p>
      )}
    </section>
  );
}
