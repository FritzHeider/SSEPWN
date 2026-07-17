import { DEFAULT_HOOK_PHRASES, type SignalName } from "./score";

/**
 * Highlight-clip tuning. Every field is optional so a stored per-project config
 * or a job payload (the regenerate API) can override just the knobs it cares
 * about and inherit the rest — which is what makes clip generation
 * "config-live": change `hookPhrases` and a different moment ranks first.
 *
 * This lives in `lib/highlights` (not the worker handler) because three callers
 * need it — the generate-clips handler, the config API, and the regenerate API —
 * and none of them should reach across the worker/route boundary for a plain
 * data shape.
 */
export interface ClipConfig {
  /** Shortest clip, seconds (SPEC: 15–90). */
  minLen?: number;
  /** Longest clip, seconds. */
  maxLen?: number;
  /** Sliding-window length the scan uses, seconds. */
  windowLen?: number;
  /** Window step, seconds. */
  step?: number;
  /** Max clips to keep (SPEC: 5–10). */
  count?: number;
  /** Minimum seconds between two kept clips (SPEC: ≥5). */
  minGap?: number;
  /** Hook phrases that fire the hook signal. */
  hookPhrases?: string[];
  /** Per-signal weight overrides. */
  weights?: Partial<Record<SignalName, number>>;
}

/** The numeric knobs — the fields `num`-validated and merged field-by-field. */
export const NUMERIC_KEYS = [
  "minLen",
  "maxLen",
  "windowLen",
  "step",
  "count",
  "minGap",
] as const;

/** The five scoring signals whose weights a config may override. */
export const SIGNAL_NAMES: readonly SignalName[] = [
  "energy",
  "speechDensity",
  "hook",
  "emphasis",
  "laughter",
];

/** Config defaults — the neutral run when a project has no overrides yet. */
export const DEFAULT_CLIP_CONFIG: Required<
  Pick<ClipConfig, (typeof NUMERIC_KEYS)[number]>
> = {
  minLen: 15,
  maxLen: 90,
  windowLen: 30,
  step: 5,
  count: 5,
  minGap: 5,
};

/** A config with every field filled in — what the scorer actually runs on. */
export interface ResolvedClipConfig {
  minLen: number;
  maxLen: number;
  windowLen: number;
  step: number;
  count: number;
  minGap: number;
  hookPhrases: string[];
  weights?: Partial<Record<SignalName, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a {@link ClipConfig} out of an untrusted value (a job payload or a
 * request body), keeping only well-typed fields. Data crossing a boundary is
 * validated here (SPEC: validate at boundaries), so a stray `minLen: "20"` is
 * dropped rather than smuggled into the scoring arithmetic where it would
 * surface as a silent NaN. The result therefore contains only clean overrides —
 * exactly what is safe to persist as the per-project config.
 */
export function parseClipConfig(payload: unknown): ClipConfig {
  if (!isRecord(payload)) return {};
  const config: ClipConfig = {};

  for (const key of NUMERIC_KEYS) {
    const value = num(payload[key]);
    if (value !== undefined) config[key] = value;
  }

  if (Array.isArray(payload.hookPhrases)) {
    const phrases = payload.hookPhrases.filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    if (phrases.length > 0) config.hookPhrases = phrases;
  }

  if (isRecord(payload.weights)) {
    const weights: Partial<Record<SignalName, number>> = {};
    for (const name of SIGNAL_NAMES) {
      const value = num(payload.weights[name]);
      if (value !== undefined) weights[name] = value;
    }
    if (Object.keys(weights).length > 0) config.weights = weights;
  }

  return config;
}

/**
 * Layer `override` on top of `base`, field by field. A field the override omits
 * keeps the base value; weights merge per-signal (so an override tweaking one
 * signal weight does not wipe the others). This is how a project's stored config
 * (the base) and a per-run job payload (the override) combine.
 */
export function mergeConfig(base: ClipConfig, override: ClipConfig): ClipConfig {
  const merged: ClipConfig = { ...base, ...override };
  if (base.weights || override.weights) {
    merged.weights = { ...base.weights, ...override.weights };
  }
  return merged;
}

/** Merge parsed overrides over the defaults into a fully-resolved config. */
export function resolveConfig(config: ClipConfig): ResolvedClipConfig {
  return {
    minLen: config.minLen ?? DEFAULT_CLIP_CONFIG.minLen,
    maxLen: config.maxLen ?? DEFAULT_CLIP_CONFIG.maxLen,
    windowLen: config.windowLen ?? DEFAULT_CLIP_CONFIG.windowLen,
    step: config.step ?? DEFAULT_CLIP_CONFIG.step,
    count: config.count ?? DEFAULT_CLIP_CONFIG.count,
    minGap: config.minGap ?? DEFAULT_CLIP_CONFIG.minGap,
    hookPhrases: config.hookPhrases ?? [...DEFAULT_HOOK_PHRASES],
    weights: config.weights,
  };
}
