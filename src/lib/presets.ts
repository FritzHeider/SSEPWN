/**
 * Platform export presets (SPEC.md § Platform presets, Phase 09).
 *
 * The five target presets a clip can be exported to, as typed constants: aspect
 * ratio, output resolution, an optional max-length warning threshold, and
 * whether captions are burned in. This is pure data + a couple of total
 * functions over it — no DB, no React — so the export pipeline (Phase 10), the
 * project/clip selection surface, and the editor's warning badge all read the
 * same table.
 *
 * A preset's `maxLengthSec` is a *soft* limit: exceeding it does not block
 * export, it just surfaces a warning badge ("Shorts ≤ 60 s"). `null` means the
 * platform imposes no practical limit for our purposes (square/landscape).
 */

import type { AspectRatio } from "./crop/types";

/** The five platform presets from SPEC.md § Platform presets. */
export type PlatformPresetId =
  | "tiktok"
  | "youtube-shorts"
  | "instagram-reels"
  | "square"
  | "landscape";

/** One row of the platform-preset table. */
export interface PlatformPreset {
  id: PlatformPresetId;
  /** Human-facing name for the picker/badge. */
  label: string;
  /** Reframe target, shared with the crop model. */
  aspectRatio: AspectRatio;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /**
   * Soft max clip length in seconds; a clip longer than this earns a warning
   * badge. `null` when the platform has no length limit worth warning about.
   */
  maxLengthSec: number | null;
  /** Whether captions are burned into the exported file for this platform. */
  burnCaptions: boolean;
}

/**
 * The preset applied when a project/clip has not chosen one. TikTok 9:16 is the
 * product's default target (SPEC.md § Product summary leads with TikTok).
 */
export const DEFAULT_PLATFORM_PRESET: PlatformPresetId = "tiktok";

/** The platform-preset table, keyed by id (SPEC.md § Platform presets). */
export const PLATFORM_PRESETS: Record<PlatformPresetId, PlatformPreset> = {
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    maxLengthSec: 600, // 10 min
    burnCaptions: true,
  },
  "youtube-shorts": {
    id: "youtube-shorts",
    label: "YouTube Shorts",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    maxLengthSec: 60,
    burnCaptions: true,
  },
  "instagram-reels": {
    id: "instagram-reels",
    label: "Instagram Reels",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    maxLengthSec: 90,
    burnCaptions: true,
  },
  square: {
    id: "square",
    label: "Square",
    aspectRatio: "1:1",
    width: 1080,
    height: 1080,
    maxLengthSec: null,
    burnCaptions: false,
  },
  landscape: {
    id: "landscape",
    label: "Landscape",
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    maxLengthSec: null,
    burnCaptions: false,
  },
};

/** Presets in display order (9:16 platforms first, then square/landscape). */
export const PLATFORM_PRESET_LIST: readonly PlatformPreset[] = [
  PLATFORM_PRESETS.tiktok,
  PLATFORM_PRESETS["youtube-shorts"],
  PLATFORM_PRESETS["instagram-reels"],
  PLATFORM_PRESETS.square,
  PLATFORM_PRESETS.landscape,
];

/** The preset ids, in display order. */
export const PLATFORM_PRESET_IDS: readonly PlatformPresetId[] = PLATFORM_PRESET_LIST.map(
  (p) => p.id,
);

/** True when `value` is a known preset id. */
export function isPlatformPresetId(value: unknown): value is PlatformPresetId {
  return (
    typeof value === "string" && (PLATFORM_PRESET_IDS as readonly string[]).includes(value)
  );
}

/** Look up a preset by id, or `undefined` when the id is unknown. */
export function getPlatformPreset(id: unknown): PlatformPreset | undefined {
  return isPlatformPresetId(id) ? PLATFORM_PRESETS[id] : undefined;
}

/** Resolve any (possibly invalid/absent) id to a preset, falling back to the
 * default so callers always get a complete preset to work with. */
export function resolvePlatformPreset(id: unknown): PlatformPreset {
  return getPlatformPreset(id) ?? PLATFORM_PRESETS[DEFAULT_PLATFORM_PRESET];
}

/** Tolerance so a clip landing exactly on the limit (60.0 s) never warns. */
const LENGTH_EPSILON = 1e-6;

/**
 * Whether a clip of `durationSec` exceeds the preset's soft max length. Presets
 * with no limit (`maxLengthSec === null`) never exceed. The comparison is
 * strictly greater than the limit (with a µs tolerance), so a 60.0 s clip on a
 * 60 s preset is fine and 61 s warns — matching the acceptance table.
 */
export function exceedsMaxLength(preset: PlatformPreset, durationSec: number): boolean {
  if (preset.maxLengthSec == null) return false;
  if (!Number.isFinite(durationSec)) return false;
  return durationSec > preset.maxLengthSec + LENGTH_EPSILON;
}

/** Format a max-length threshold the way the SPEC table labels it: "10 min",
 * "60 s", "90 s". Whole minutes ≥ 2 read as minutes; everything else as seconds. */
export function formatMaxLength(sec: number): string {
  if (sec >= 120 && sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/**
 * The warning message for a clip that exceeds its preset's length, or `null`
 * when it fits (or the preset has no limit). e.g. "YouTube Shorts ≤ 60 s".
 */
export function maxLengthWarning(preset: PlatformPreset, durationSec: number): string | null {
  if (!exceedsMaxLength(preset, durationSec)) return null;
  return `${preset.label} ≤ ${formatMaxLength(preset.maxLengthSec as number)}`;
}
