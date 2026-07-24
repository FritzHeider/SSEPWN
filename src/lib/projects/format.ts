/**
 * Pure byte/rate/percent formatting for the upload-progress UI (item 19).
 *
 * React-free and Node-free like the rest of `lib/projects/*`, so the XHR upload
 * flow in `projects-panel.tsx` stays a thin wire between the progress events and
 * these labels, and the arithmetic that would otherwise hide in JSX is tested
 * here. Binary units (1 KB = 1024 B) match how a file manager reports a size, so
 * "1.2 GB" here is the same number the user saw when they picked the file.
 */

const KB = 1024;
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * A byte count as a short human label: "820 B", "1.2 MB", "2.0 GB". Picks the
 * largest unit that keeps the number below 1024, one decimal past KB (a bare
 * "1 MB" hides how far a 1.9 MB upload really is). Non-finite or negative input
 * reads as "0 B" rather than "NaN"/"-3 B", since a progress label must never
 * look broken.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB;
    unit += 1;
  }
  // Bytes are always whole; KB and up read better with one decimal.
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}

/** A transfer rate as "3.4 MB/s", built on `formatBytes`. A non-finite or
 * non-positive rate (the first tick, before any bytes have a time delta) reads
 * as an empty string so the caller can simply omit it. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** `loaded / total` as a whole percent, clamped to 0–100. Total of 0 (or
 * non-finite) yields 0 rather than a divide-by-zero NaN. */
export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  const pct = Math.round((loaded / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** "1.2 MB / 3.4 MB" — the transferred/total line under the progress bar. */
export function transferredLabel(loaded: number, total: number): string {
  return `${formatBytes(loaded)} / ${formatBytes(total)}`;
}
