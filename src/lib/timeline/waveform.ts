/**
 * Pure pixel maths for the timeline's waveform track (item 14 UI). The project's
 * waveform PNG spans the WHOLE source duration; the clip strip shows only the
 * clip's `[inPoint, outPoint]` window, stretched to the strip's pixel width. This
 * module turns those four numbers into the CSS `background-size` / `background-
 * position` a `<div>` needs to display exactly that slice, so the component holds
 * no arithmetic (the same DEC-005 split the rest of the timeline UI follows).
 *
 * The image is used as a horizontal background: we scale it so the clip window
 * maps onto the strip width, then offset it so the window's left edge sits at
 * x=0. Vertically the image always fills the track height (`100%`).
 */

/** The CSS the waveform `<div>` applies to show the clip's slice of the image. */
export interface WaveformSlice {
  /** `background-size` horizontal component, in px (the full image's scaled width). */
  backgroundWidthPx: number;
  /** `background-position` horizontal component, in px (negative: scroll left). */
  offsetPx: number;
}

/**
 * Background width + horizontal offset so a `stripWidthPx`-wide track shows the
 * `[inPoint, outPoint]` window of a waveform image that spans `durationSec`.
 *
 * `backgroundWidthPx` stretches the full image so the clip window (`out − in`
 * seconds) is exactly `stripWidthPx` wide; `offsetPx` scrolls the image left so
 * the window's start aligns to the track's left edge. Returns a zero slice when
 * the inputs are degenerate (no duration, zero-length window, unmeasured strip),
 * so the track simply renders blank rather than `NaN`.
 */
export function waveformSlice(
  inPoint: number,
  outPoint: number,
  durationSec: number,
  stripWidthPx: number,
): WaveformSlice {
  const clipDuration = outPoint - inPoint;
  if (
    !Number.isFinite(clipDuration) ||
    clipDuration <= 0 ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    !Number.isFinite(stripWidthPx) ||
    stripWidthPx <= 0 ||
    inPoint < 0
  ) {
    return { backgroundWidthPx: 0, offsetPx: 0 };
  }
  const pxPerSec = stripWidthPx / clipDuration;
  return {
    backgroundWidthPx: durationSec * pxPerSec,
    offsetPx: -inPoint * pxPerSec,
  };
}
