import { execa } from "execa";

/**
 * Decode any media file's first audio stream to raw signed-16-bit little-endian
 * mono PCM at `sampleRate`, returned as an `Int16Array` of samples.
 *
 * This is the ffmpeg half of `audioEnergy` (SPEC.md § Highlight scoring — audio
 * RMS energy): the RMS-per-window maths is pure and lives in
 * `src/lib/highlights`, but decoding compressed audio to samples is an ffmpeg
 * job and so lives here with every other ffmpeg invocation (global constraint:
 * all ffmpeg calls in `src/lib/ffmpeg/`).
 *
 * `-ac 1` downmixes so a stereo source yields one energy series rather than two;
 * `-ar` resamples so the window→sample-count maths is independent of the
 * source's rate. Output goes to `pipe:1` and is captured as bytes — decoding to
 * a temp file first would only add I/O and a cleanup path.
 *
 * Rejects with execa's error (including ffmpeg's stderr) if the source has no
 * audio track or cannot be decoded.
 */
export async function decodePcmMono(sourcePath: string, sampleRate: number): Promise<Int16Array> {
  const { stdout } = await execa(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );

  // `stdout` is a Uint8Array of raw s16le bytes. Copy it into a fresh, 2-byte
  // aligned buffer before viewing it as Int16Array: a subarray view can start at
  // an odd byteOffset, which `new Int16Array(buffer, offset)` rejects. s16le
  // matches Int16Array's native layout on the LE platforms this runs on. An odd
  // trailing byte (never emitted by ffmpeg, but cheap to guard) is dropped.
  const bytes = stdout as unknown as Uint8Array;
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const aligned = new Uint8Array(sampleCount * 2);
  aligned.set(bytes.subarray(0, sampleCount * 2));
  return new Int16Array(aligned.buffer);
}
