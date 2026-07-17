/**
 * Pure signal maths for highlight detection (SPEC.md § Highlight scoring). No
 * ffmpeg, no I/O — everything here takes plain arrays so it is unit-testable
 * without media. The ffmpeg extractors in `src/lib/ffmpeg` produce the inputs.
 */

/** s16le samples range ±32768; normalise to ±1 so RMS is comparable across sources. */
const FULL_SCALE = 32768;

/**
 * Root-mean-square amplitude of each fixed-length window of PCM samples,
 * returned as one value in [0, 1] per window.
 *
 * Loud passages produce larger RMS than quiet ones, which is the whole point:
 * this is the "audio energy" the scorer looks for peaks in. The final window is
 * kept even when it is shorter than the rest (a 90.4 s clip has a 25th, partial
 * second of speech worth scoring) — RMS already averages over however many
 * samples it holds, so a short tail is not unfairly weighted.
 *
 * @param samples mono PCM, signed 16-bit.
 * @param sampleRate samples per second — sets how many samples a window spans.
 * @param windowSec window length in seconds (default 1). Must be > 0.
 * @returns `ceil(samples.length / windowSamples)` values; `[]` for empty input.
 */
export function rmsPerWindow(
  samples: Int16Array,
  sampleRate: number,
  windowSec = 1,
): number[] {
  if (windowSec <= 0) {
    throw new Error(`windowSec must be > 0, got ${windowSec}`);
  }
  if (sampleRate <= 0) {
    throw new Error(`sampleRate must be > 0, got ${sampleRate}`);
  }

  const windowSamples = Math.round(sampleRate * windowSec);
  const windows: number[] = [];

  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(start + windowSamples, samples.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const normalised = samples[i] / FULL_SCALE;
      sumSquares += normalised * normalised;
    }
    windows.push(Math.sqrt(sumSquares / (end - start)));
  }

  return windows;
}
