/**
 * Caption style model + presets (SPEC.md § Captions, Phase 05 "Style model +
 * 4 presets").
 *
 * A `CaptionStyle` is the per-clip look of the burned-in captions: font,
 * colors, stroke, optional background box, on-screen position, and the two
 * toggles (uppercase, karaoke word-highlight). It is stored inside the clip's
 * caption document (`clip_edits.state`) alongside the word-timed lines from
 * `clipCaptions`, and is later consumed by `toAss` to emit ASS styles.
 *
 * Like the highlight config this module is pure and boundary-validated:
 *  - `PRESETS` are the ≥4 named looks the SPEC requires.
 *  - `parseStyle` accepts an untrusted object (a PATCH body, a stored blob)
 *    and keeps only well-typed, in-range fields — everything else is dropped,
 *    never trusted. This is the validate-at-boundary rule the rest of the app
 *    follows (highlights `parseClipConfig`).
 *  - `resolveStyle` layers a preset + overrides into a complete style with no
 *    missing fields, so downstream code (`toAss`, the editor preview) never
 *    has to guess a default.
 *
 * Colors are user-facing `#RRGGBB` hex strings here; the ASS renderer converts
 * them to ASS's `&HBBGGRR` form. Sizes/margins are pixels relative to the
 * rendered video height (`toAss` receives the real video dimensions).
 */

/** Where the caption block sits vertically. Horizontal is always centered. */
export type CaptionPosition = "top" | "middle" | "bottom";

/** The named looks. `bold-pop` is the default (TikTok-style, karaoke on). */
export type CaptionPreset = "bold-pop" | "clean-sub" | "minimal-caps" | "boxed";

/** A fully-resolved caption style — every field present, ready for `toAss`. */
export interface CaptionStyle {
  /** Font family name (must exist on the render host for burn-in). */
  fontFamily: string;
  /** Font size in pixels at the reference video height. */
  fontSize: number;
  /** Base text color, `#RRGGBB`. */
  textColor: string;
  /** Color the currently-spoken word takes when `karaoke` is on, `#RRGGBB`. */
  highlightColor: string;
  /** Outline color, `#RRGGBB`. */
  strokeColor: string;
  /** Outline width in pixels (0 disables the outline). */
  strokeWidth: number;
  /** Whether to draw a filled background box behind the text. */
  box: boolean;
  /** Background box color, `#RRGGBB` (used only when `box` is true). */
  boxColor: string;
  /** Background box opacity, 0 (transparent) … 1 (opaque). */
  boxOpacity: number;
  /** Vertical anchor of the caption block. */
  position: CaptionPosition;
  /** Distance in pixels from the anchored edge. */
  marginV: number;
  /** Force text to UPPERCASE. */
  uppercase: boolean;
  /** Highlight the spoken word as it plays (`\k` karaoke tags in ASS). */
  karaoke: boolean;
}

/** A style as it arrives from a client: a preset name plus partial overrides. */
export interface CaptionStyleInput extends Partial<CaptionStyle> {
  preset?: CaptionPreset;
}

export const CAPTION_POSITIONS: readonly CaptionPosition[] = [
  "top",
  "middle",
  "bottom",
];

export const CAPTION_PRESET_NAMES: readonly CaptionPreset[] = [
  "bold-pop",
  "clean-sub",
  "minimal-caps",
  "boxed",
];

/** The look applied when neither a preset nor overrides are supplied. */
export const DEFAULT_CAPTION_PRESET: CaptionPreset = "bold-pop";

/**
 * The four required style presets. Each is a complete `CaptionStyle`, so a
 * preset alone is a valid style. `resolveStyle` returns copies, so callers can
 * never mutate these shared objects.
 */
export const PRESETS: Record<CaptionPreset, CaptionStyle> = {
  // TikTok-style: big chunky sans, bright karaoke highlight, heavy outline.
  "bold-pop": {
    fontFamily: "Montserrat",
    fontSize: 64,
    textColor: "#FFFFFF",
    highlightColor: "#FFE600",
    strokeColor: "#000000",
    strokeWidth: 6,
    box: false,
    boxColor: "#000000",
    boxOpacity: 0.6,
    position: "middle",
    marginV: 220,
    uppercase: true,
    karaoke: true,
  },
  // Classic bottom subtitle: understated, thin outline, no karaoke.
  "clean-sub": {
    fontFamily: "Arial",
    fontSize: 42,
    textColor: "#FFFFFF",
    highlightColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 2,
    box: false,
    boxColor: "#000000",
    boxOpacity: 0.6,
    position: "bottom",
    marginV: 60,
    uppercase: false,
    karaoke: false,
  },
  // Minimal all-caps: no outline, no box, quiet.
  "minimal-caps": {
    fontFamily: "Helvetica",
    fontSize: 40,
    textColor: "#FFFFFF",
    highlightColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 0,
    box: false,
    boxColor: "#000000",
    boxOpacity: 0.5,
    position: "bottom",
    marginV: 80,
    uppercase: true,
    karaoke: false,
  },
  // Solid background box behind the text; outline off.
  boxed: {
    fontFamily: "Arial",
    fontSize: 44,
    textColor: "#FFFFFF",
    highlightColor: "#FFE600",
    strokeColor: "#000000",
    strokeWidth: 0,
    box: true,
    boxColor: "#000000",
    boxOpacity: 0.75,
    position: "bottom",
    marginV: 70,
    uppercase: false,
    karaoke: false,
  },
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isPreset(value: unknown): value is CaptionPreset {
  return (
    typeof value === "string" &&
    (CAPTION_PRESET_NAMES as readonly string[]).includes(value)
  );
}

function isPosition(value: unknown): value is CaptionPosition {
  return (
    typeof value === "string" &&
    (CAPTION_POSITIONS as readonly string[]).includes(value)
  );
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Keep only well-typed, in-range fields from an untrusted style object.
 * Unknown keys, wrong types, malformed colors, negative sizes and
 * out-of-range values are silently dropped so a bad PATCH can never corrupt a
 * stored style. Returns a fresh object owning only the fields it validated.
 */
export function parseStyle(input: unknown): CaptionStyleInput {
  const out: CaptionStyleInput = {};
  if (typeof input !== "object" || input === null) return out;
  const raw = input as Record<string, unknown>;

  if (isPreset(raw.preset)) out.preset = raw.preset;

  if (typeof raw.fontFamily === "string" && raw.fontFamily.trim().length > 0) {
    out.fontFamily = raw.fontFamily.trim();
  }
  if (finite(raw.fontSize) && raw.fontSize > 0) out.fontSize = raw.fontSize;

  if (isColor(raw.textColor)) out.textColor = raw.textColor;
  if (isColor(raw.highlightColor)) out.highlightColor = raw.highlightColor;
  if (isColor(raw.strokeColor)) out.strokeColor = raw.strokeColor;
  if (finite(raw.strokeWidth) && raw.strokeWidth >= 0) {
    out.strokeWidth = raw.strokeWidth;
  }

  if (typeof raw.box === "boolean") out.box = raw.box;
  if (isColor(raw.boxColor)) out.boxColor = raw.boxColor;
  if (finite(raw.boxOpacity) && raw.boxOpacity >= 0 && raw.boxOpacity <= 1) {
    out.boxOpacity = raw.boxOpacity;
  }

  if (isPosition(raw.position)) out.position = raw.position;
  if (finite(raw.marginV) && raw.marginV >= 0) out.marginV = raw.marginV;

  if (typeof raw.uppercase === "boolean") out.uppercase = raw.uppercase;
  if (typeof raw.karaoke === "boolean") out.karaoke = raw.karaoke;

  return out;
}

/** Return a preset by name (a copy), or the default preset for unknown names. */
export function getPreset(name: unknown): CaptionStyle {
  const preset = isPreset(name) ? name : DEFAULT_CAPTION_PRESET;
  return { ...PRESETS[preset] };
}

/**
 * Layer a preset and cleaned overrides into a complete style.
 *
 * The base is the input's `preset` (or the default preset); every other
 * supplied field overrides that base. Input is run through `parseStyle` first,
 * so callers may pass a raw client object directly. The result is always a
 * fully-populated `CaptionStyle`.
 */
export function resolveStyle(input?: unknown): CaptionStyle {
  const { preset, ...overrides } = parseStyle(input);
  return { ...getPreset(preset), ...overrides };
}
