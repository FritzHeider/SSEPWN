"use client";

import type { CaptionStyle, CaptionStyleInput } from "@/lib/captions/style";
import { CAPTION_POSITIONS } from "@/lib/captions/style";
import { PRESET_OPTIONS } from "@/lib/captions/preview";

/**
 * The caption style panel: preset buttons + a few direct controls. Every control
 * emits a `set-style` edit through `onStyle` — a preset button rebases the whole
 * look, a field control layers onto the current style. The panel is controlled:
 * it renders `style` and never keeps its own copy, so it always shows the server's
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
    <section className="flex flex-col gap-4 rounded-lg border border-border-subtle p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Style</h2>

      <div className="flex flex-wrap gap-2">
        {PRESET_OPTIONS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            disabled={disabled}
            onClick={() => onStyle({ preset: preset.value })}
            aria-pressed={activePreset === preset.value}
            className={`cursor-pointer rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              activePreset === preset.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-border-subtle text-text hover:bg-surface-overlay"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Font size</span>
          <input
            type="range"
            min={16}
            max={120}
            step={2}
            value={style.fontSize}
            disabled={disabled}
            onChange={(e) => onStyle({ fontSize: Number(e.target.value) })}
            className="cursor-pointer accent-accent"
          />
          <span className="font-mono tabular-nums text-text-muted">{style.fontSize}px</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Position</span>
          <select
            value={style.position}
            disabled={disabled}
            onChange={(e) => onStyle({ position: e.target.value as CaptionStyle["position"] })}
            className="cursor-pointer rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {CAPTION_POSITIONS.map((pos) => (
              <option key={pos} value={pos}>
                {pos}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-text-muted">Text</span>
          <input
            type="color"
            value={style.textColor}
            disabled={disabled}
            onChange={(e) => onStyle({ textColor: e.target.value.toUpperCase() })}
            className="h-7 w-10 cursor-pointer rounded border border-border-subtle"
          />
        </label>

        <label className="flex items-center gap-2">
          <span className="text-text-muted">Highlight</span>
          <input
            type="color"
            value={style.highlightColor}
            disabled={disabled}
            onChange={(e) => onStyle({ highlightColor: e.target.value.toUpperCase() })}
            className="h-7 w-10 cursor-pointer rounded border border-border-subtle"
          />
        </label>

        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={style.uppercase}
            disabled={disabled}
            onChange={(e) => onStyle({ uppercase: e.target.checked })}
            className="cursor-pointer accent-accent"
          />
          <span className="text-text-muted">Uppercase</span>
        </label>

        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={style.karaoke}
            disabled={disabled}
            onChange={(e) => onStyle({ karaoke: e.target.checked })}
            className="cursor-pointer accent-accent"
          />
          <span className="text-text-muted">Karaoke highlight</span>
        </label>

        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={style.box}
            disabled={disabled}
            onChange={(e) => onStyle({ box: e.target.checked })}
            className="cursor-pointer accent-accent"
          />
          <span className="text-text-muted">Background box</span>
        </label>
      </div>
    </section>
  );
}
