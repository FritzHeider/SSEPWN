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
