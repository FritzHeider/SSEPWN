/**
 * Pure converters from a clip's `CaptionDoc` to SubRip (.srt) and WebVTT (.vtt)
 * sidecar subtitle files (phase-BE task 6). Text-in / text-out — no ffmpeg, no
 * DB, no clock — so the exact bytes are unit-testable, mirroring `toAss`.
 *
 * Both formats emit one entry per caption cue (the same on-screen block `toAss`
 * turns into one Dialogue event), timed clip-relative exactly as the cues are
 * stored. The only structural differences between the two are the header (VTT
 * has `WEBVTT`, SRT has none), the sequential 1-based index (SRT only), and the
 * decimal separator in timestamps: SRT uses `hh:mm:ss,mmm`, VTT `hh:mm:ss.mmm`.
 *
 * Empty cues (no rendered text) are skipped, and SRT indices count only emitted
 * entries so they stay sequential with no gaps.
 */

import type { CaptionDoc } from "./ass";
import type { CaptionCue } from "./clip";

/** Split whole milliseconds off a clip-relative second value, clamped at zero. */
function timeParts(seconds: number): { hh: string; mm: string; ss: string; mmm: string } {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return { hh: pad(hh, 2), mm: pad(mm, 2), ss: pad(ss, 2), mmm: pad(ms, 3) };
}

/** SubRip timestamp `hh:mm:ss,mmm`. */
export function srtTime(seconds: number): string {
  const { hh, mm, ss, mmm } = timeParts(seconds);
  return `${hh}:${mm}:${ss},${mmm}`;
}

/** WebVTT timestamp `hh:mm:ss.mmm`. */
export function vttTime(seconds: number): string {
  const { hh, mm, ss, mmm } = timeParts(seconds);
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/** A cue's visible text: its lines joined by newlines, trimmed. Empty when the
 * cue carries nothing to show. */
function cueText(cue: CaptionCue): string {
  return cue.lines
    .map((line) => line.text.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Render a `CaptionDoc` as a SubRip (.srt) document. */
export function captionDocToSrt(doc: CaptionDoc): string {
  const blocks: string[] = [];
  let index = 0;
  for (const cue of doc.cues) {
    const text = cueText(cue);
    if (text.length === 0) continue;
    index += 1;
    blocks.push(`${index}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${text}`);
  }
  // Trailing newline so the final entry is terminated; empty doc → empty string.
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

/** Render a `CaptionDoc` as a WebVTT (.vtt) document. */
export function captionDocToVtt(doc: CaptionDoc): string {
  const blocks: string[] = ["WEBVTT"];
  for (const cue of doc.cues) {
    const text = cueText(cue);
    if (text.length === 0) continue;
    blocks.push(`${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${text}`);
  }
  return `${blocks.join("\n\n")}\n`;
}
