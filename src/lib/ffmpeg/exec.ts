import { open } from "node:fs/promises";

import { execa, type Result } from "execa";

export interface ProbeResult {
  /** Duration in seconds. */
  duration: number;
  width: number;
  height: number;
  /** Frames per second (parsed from ffprobe's rational, e.g. "30000/1001"). */
  fps: number;
  hasAudio: boolean;
}

export interface AudioProbeResult {
  /** Samples per second, e.g. 16000. */
  sampleRate: number;
  channels: number;
  codec: string;
  /** Duration in seconds. */
  duration: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/**
 * Run ffmpeg with an explicit argument array (never a shell string).
 * Rejects with execa's error (including stderr) on non-zero exit.
 */
export function runFfmpeg(args: string[]): Promise<Result> {
  return execa("ffmpeg", args);
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

/**
 * Probe a media file with ffprobe. Rejects if ffprobe fails (e.g. the file
 * is not media) or if the file contains no video stream.
 */
export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await execa("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) {
    throw new Error(`No video stream found in ${path}`);
  }


  const duration = Number(parsed.format?.duration ?? video.duration ?? 0);

  return {
    duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/**
 * Whether an MP4's `moov` atom precedes its `mdat` atom — i.e. the file was
 * muxed with `+faststart` so a player can begin before the whole file downloads.
 *
 * Reads only the top-level box headers (8 or 16 bytes each), never the payload,
 * so it is cheap even on large exports. Returns `false` for a file missing
 * either atom or not a well-formed MP4 (rather than throwing) — callers treat a
 * non-faststart or non-MP4 file the same way. Used by the export integration
 * tests to prove the `-movflags +faststart` flag actually took effect.
 */
export async function probeFaststart(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    let moovAt = -1;
    let mdatAt = -1;
    while (offset + 8 <= size) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        // 64-bit largesize in the next 8 bytes.
        const high = header.readUInt32BE(8);
        const low = header.readUInt32BE(12);
        boxSize = high * 2 ** 32 + low;
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset; // extends to end of file
      }
      if (type === "moov" && moovAt < 0) moovAt = offset;
      if (type === "mdat" && mdatAt < 0) mdatAt = offset;
      if (moovAt >= 0 && mdatAt >= 0) break;
      if (boxSize < headerLen) break; // malformed — bail rather than loop forever
      offset += boxSize;
    }
    if (moovAt < 0 || mdatAt < 0) return false;
    return moovAt < mdatAt;
  } finally {
    await fh.close();
  }
}

/**
 * Probe the first audio stream of a file.
 *
 * Separate from `probe()` because that one insists on a video stream — it
 * cannot describe a bare WAV, which is exactly what the transcription pipeline
 * produces and needs to verify.
 *
 * Rejects if ffprobe fails or the file has no audio stream.
 */
export async function probeAudio(path: string): Promise<AudioProbeResult> {
  const { stdout } = await execa("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const audio = (parsed.streams ?? []).find((s) => s.codec_type === "audio");
  if (!audio) {
    throw new Error(`No audio stream found in ${path}`);
  }

  return {
    sampleRate: Number(audio.sample_rate ?? 0),
    channels: audio.channels ?? 0,
    codec: audio.codec_name ?? "",
    duration: Number(parsed.format?.duration ?? audio.duration ?? 0),
  };
}
