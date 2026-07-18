import type { CropKeyframe } from "./types";

/**
 * Turn the sparse crop-window keyframes that `planCrop` emits into a single
 * ffmpeg `crop,scale` filtergraph string (phase-06 / SPEC.md § Smart crop).
 * Pure — it builds a string and never shells out, so it is unit-tested with
 * hand-written keyframes and no ffmpeg (the real ffmpeg run lives in one
 * integration test that feeds this output to `runFfmpeg`).
 *
 * The crop window's size is constant across a plan — only its top-left pans —
 * so the graph is one `crop=W:H:x(t):y(t)` whose `x`/`y` are expressions in
 * ffmpeg's frame-time variable `t` that interpolate the keyframe positions
 * PIECEWISE-LINEARLY, followed by a `scale` to the delivery resolution. Because
 * `planCrop` already clamps every keyframe inside the source, a linear blend of
 * two in-bounds endpoints is itself in-bounds, so the window never runs off the
 * frame between keyframes.
 */

export interface CropFilterOptions {
  /**
   * Output width in pixels. Defaults to the crop window width snapped down to an
   * even number (h264 requires even dimensions). Pass an exact-ratio even size
   * to guarantee the encoded output probes to precisely the target aspect ratio.
   */
  outputWidth?: number;
  /** Output height in pixels. Defaults to the crop window height snapped even. */
  outputHeight?: number;
}

/**
 * ffmpeg's filtergraph parser treats a bare comma as the separator BETWEEN
 * filters, so any comma inside a filter option's value (every `if`/`lt`/`+`
 * function call below has them) has to be escaped or the graph splits mid-
 * expression. `\,` survives the parser and reaches the expression evaluator as a
 * literal comma. Passed through an execa argv (never a shell), the backslash is
 * taken literally, which is exactly what ffmpeg wants.
 */
const C = "\\,";

/** Format a number for embedding in an expression: integers verbatim, floats trimmed. */
function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

/** Round down to the nearest even integer ≥ 2 — the smallest size h264 will encode. */
function evenDown(n: number): number {
  const e = Math.floor(n) - (Math.floor(n) % 2);
  return Math.max(e, 2);
}

/**
 * Drop keyframes whose timestamp does not strictly advance. `planCrop` already
 * emits time-ordered keyframes, but a degenerate run with duplicate timestamps
 * would produce a divide-by-zero segment (`/(Tb-Ta)`); keeping the later value
 * at a shared timestamp preserves the intended position without the singularity.
 */
function strictlyIncreasing(keyframes: CropKeyframe[]): CropKeyframe[] {
  const out: CropKeyframe[] = [];
  for (const kf of keyframes) {
    if (out.length > 0 && kf.t <= out[out.length - 1].t) {
      out[out.length - 1] = kf;
      continue;
    }
    out.push(kf);
  }
  return out;
}

/**
 * Build the piecewise-linear expression for one axis (`x` or `y`) over the
 * keyframes. Before the first keyframe and after the last the value is held
 * constant (no extrapolation); in between it eases linearly from one keyframe to
 * the next. All commas are pre-escaped for the filtergraph.
 */
function axisExpr(keyframes: CropKeyframe[], pick: (k: CropKeyframe) => number): string {
  if (keyframes.length === 1) return num(pick(keyframes[0]));

  const last = keyframes.length - 1;
  // Innermost fallback: after the final keyframe, hold the final value.
  let expr = num(pick(keyframes[last]));

  // Wrap each segment [i, i+1] as `if(t < T[i+1], lerp_i, rest)`, inside-out.
  for (let i = last - 1; i >= 0; i--) {
    const ta = keyframes[i].t;
    const tb = keyframes[i + 1].t;
    const xa = pick(keyframes[i]);
    const xb = pick(keyframes[i + 1]);
    const lerp = `${num(xa)}+(${num(xb)}-${num(xa)})*(t-${num(ta)})/(${num(tb)}-${num(ta)})`;
    expr = `if(lt(t${C}${num(tb)})${C}${lerp}${C}${expr})`;
  }

  // Outer guard: before the first keyframe, hold the first value (the first
  // segment's lerp would otherwise extrapolate below it for t < T[0]).
  const t0 = keyframes[0].t;
  expr = `if(lt(t${C}${num(t0)})${C}${num(pick(keyframes[0]))}${C}${expr})`;
  return expr;
}

/**
 * Build the `crop=W:H:x(t):y(t),scale=OW:OH` filter for a plan's keyframes.
 * Throws on an empty plan (there is nothing to crop to) — every caller has at
 * least the single centred keyframe `planCrop` guarantees.
 */
export function cropFilter(keyframes: CropKeyframe[], options: CropFilterOptions = {}): string {
  const kf = strictlyIncreasing(keyframes);
  if (kf.length === 0) {
    throw new Error("cropFilter needs at least one keyframe");
  }

  const w = kf[0].w;
  const h = kf[0].h;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`cropFilter needs a positive crop size, got ${w}×${h}`);
  }

  const xExpr = axisExpr(kf, (k) => k.x);
  const yExpr = axisExpr(kf, (k) => k.y);
  const outW = options.outputWidth ?? evenDown(w);
  const outH = options.outputHeight ?? evenDown(h);

  return `crop=${w}:${h}:${xExpr}:${yExpr},scale=${outW}:${outH}`;
}
