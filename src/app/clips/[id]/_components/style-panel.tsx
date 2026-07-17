"use client";

import type { CaptionStyle, CaptionStyleInput } from "@/lib/captions/style";
import { CAPTION_POSITIONS } from "@/lib/captions/style";
import { PRESET_OPTIONS } from "@/lib/captions/preview";

/**
 * The caption style panel: preset buttons + a few direct controls.
 *
 * Every control emits a `set-style` edit through `onStyle`. A preset button
 * sends `{ preset }`, which rebases the whole look; a field control sends just
 * that field, which layers on the clip's current style (the semantics
 * `applyCaptionEdit`'s style path implements). The panel is controlled — it
 * renders `style` and never keeps its own copy, so it always shows the server's
 * truth after each PATCH round-trips.
 */
export function StylePanel({
  style,
  activePreset,
  disabled,
  onStyle,
}: {
  style: CaptionStyle;
  activePreset: string | undefined;
  disabled: boolean;
  onStyle: (overrides: CaptionStyleInput) => void;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Style
      </h2>

      <div className="flex flex-wrap gap-2">
        {PRESET_OPTIONS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            disabled={disabled}
            onClick={() => onStyle({ preset: preset.value })}
            aria-pressed={activePreset === preset.value}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              activePreset === preset.value
                ? "border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-300"
                : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-zinc-500 dark:text-zinc-400">Font size</span>
          <input
            type="range"
            min={16}
            max={120}
            step={2}
            value={style.fontSize}
            disabled={disabled}
            onChange={(e) => onStyle({ fontSize: Number(e.target.value) })}
          />
          <span className="font-mono tabular-nums text-zinc-400">{style.fontSize}px</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-zinc-500 dark:text-zinc-400">Position</span>
          <select
            value={style.position}
            disabled={disabled}
            onChange={(e) => onStyle({ position: e.target.value as CaptionStyle["position"] })}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {CAPTION_POSITIONS.map((pos) => (
              <option key={pos} value={pos}>
                {pos}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-zinc-500 dark:text-zinc-400">Text</span>
          <input
            type="color"
            value={style.textColor}
            disabled={disabled}
            onChange={(e) => onStyle({ textColor: e.target.value.toUpperCase() })}
            className="h-6 w-10 rounded border border-zinc-300 dark:border-zinc-700"
          />
        </label>

        <label className="flex items-center gap-2">
          <span className="text-zinc-500 dark:text-zinc-400">Highlight</span>
          <input
            type="color"
            value={style.highlightColor}
            disabled={disabled}
            onChange={(e) => onStyle({ highlightColor: e.target.value.toUpperCase() })}
            className="h-6 w-10 rounded border border-zinc-300 dark:border-zinc-700"
          />
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={style.uppercase}
            disabled={disabled}
            onChange={(e) => onStyle({ uppercase: e.target.checked })}
          />
          <span className="text-zinc-500 dark:text-zinc-400">Uppercase</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={style.karaoke}
            disabled={disabled}
            onChange={(e) => onStyle({ karaoke: e.target.checked })}
          />
          <span className="text-zinc-500 dark:text-zinc-400">Karaoke highlight</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={style.box}
            disabled={disabled}
            onChange={(e) => onStyle({ box: e.target.checked })}
          />
          <span className="text-zinc-500 dark:text-zinc-400">Background box</span>
        </label>
      </div>
    </section>
  );
}
