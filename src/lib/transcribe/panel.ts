/**
 * Pure presentation logic for the transcript panel (DEC-005).
 *
 * React-free and Node-free, like projects/view.ts: the decisions live here where
 * node-env vitest can test them honestly, and the JSX that consumes them stays
 * thin enough to read at a glance.
 */

import { formatDuration } from "@/lib/projects/view";
import type { ProjectTranscript } from "@/lib/projects/transcript";
import type { TranscriptSegment } from "@/lib/transcribe/types";

/** No segment is being spoken at this time — a gap, or before speech starts. */
export const NO_ACTIVE_SEGMENT = -1;

/** The source video URL for a project. Ids come from the DB, never from input. */
export function sourceVideoUrl(projectId: number): string {
  return `/api/projects/${projectId}/video`;
}

/**
 * Why there are no sentences to show, in words a user can act on — or `null`
 * when there are sentences and the panel should just render them.
 *
 * Three different causes reach this function and each gets its own answer, for
 * the same reason `readTranscript` refuses to 404 a caption-less project: a
 * single "No transcript" string would leave the user unable to tell a video that
 * CANNOT be captioned from one that is still being worked on, and would make the
 * transcribe handler's `statusNote` ("no audio — captions unavailable")
 * unreachable from the UI it was written for.
 *
 * `statusNote` wins over the `transcribed` flag when both are present: the note
 * is the specific thing that happened, the flag is only whether it finished.
 * The last case — transcribed, no note, still no segments — is a transcript of
 * silence, which is a real outcome for a video with an audio track carrying no
 * speech, and must not read as though the pipeline is still running.
 */
export function emptyTranscriptMessage(
  transcript: Pick<ProjectTranscript, "transcribed" | "statusNote" | "segments">,
): string | null {
  if (transcript.segments.length > 0) return null;
  if (transcript.statusNote?.trim()) return transcript.statusNote.trim();
  if (!transcript.transcribed) return "Transcribing… this panel fills in when the job finishes.";
  return "No speech was detected in this video.";
}

/**
 * `m:ss` (or `h:mm:ss` past an hour) for a segment's start time.
 *
 * Delegates to the list's formatter rather than growing a second one: two mm:ss
 * implementations drift, and that one already handles both the hour rollover
 * (a 2 h podcast is a real input even though the 90 s fixture never reaches it)
 * and the negative/non-finite guards.
 */
export function formatTimestamp(seconds: number): string {
  return formatDuration(seconds);
}

/**
 * Index of the segment being spoken at `currentTime`, or `NO_ACTIVE_SEGMENT`.
 *
 * The interval is half-open, `[start, end)`: sentences abut, so an inclusive end
 * would match two segments at every boundary and silently return whichever came
 * first. A time inside a quiet gap — of which the 90 s fixture has several, and
 * real speech has many — belongs to NO segment. Returning the previous one there
 * would leave a sentence highlighted while nobody is speaking, which reads as a
 * frozen player rather than as silence.
 *
 * A non-finite `currentTime` (a `<video>` reports NaN before metadata loads)
 * needs no guard: every comparison against NaN is false, so the scan finds
 * nothing and returns NO_ACTIVE_SEGMENT on its own. An explicit check here would
 * be unreachable — the tests pin the behaviour either way.
 */
export function activeSegmentIndex(
  segments: ReadonlyArray<Pick<TranscriptSegment, "start" | "end">>,
  currentTime: number,
): number {
  return segments.findIndex((segment) => currentTime >= segment.start && currentTime < segment.end);
}
