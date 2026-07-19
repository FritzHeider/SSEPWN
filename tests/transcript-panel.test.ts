import { beforeAll, describe, expect, it } from "vitest";

import { FakeTranscriber } from "../src/lib/transcribe/fake";
import {
  NO_ACTIVE_SEGMENT,
  activeSegmentIndex,
  captionsDisabledMessage,
  emptyTranscriptMessage,
  formatTimestamp,
  sourceVideoUrl,
} from "../src/lib/transcribe/panel";
import type { TranscriptSegment } from "../src/lib/transcribe/types";
import { NO_AUDIO_NOTE } from "../src/worker/handlers/transcribe";

/**
 * The real 90 s fixture, loaded through the real FakeTranscriber — the same data
 * the pipeline feeds the panel. A hand-written array here would let the panel and
 * the fixture drift apart while both stayed green.
 */
let fixture: TranscriptSegment[];

beforeAll(async () => {
  fixture = await new FakeTranscriber().transcribe("long-sample.mp4");
});

describe("formatTimestamp", () => {
  it.each([
    [0, "0:00"],
    [4.3, "0:04"],
    [65, "1:05"],
    [90, "1:30"],
    // Past an hour it must roll over rather than render "125:00" — the fixture
    // never reaches this, a real podcast does.
    [3725, "1:02:05"],
  ])("formats %ss as %s", (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});

describe("activeSegmentIndex", () => {
  it("finds the segment being spoken at a time inside it", () => {
    const third = fixture[2];
    const midpoint = (third.start + third.end) / 2;

    expect(activeSegmentIndex(fixture, midpoint)).toBe(2);
  });

  // U7: an inclusive `end` matches BOTH segments at a shared boundary and
  // returns the earlier one. The 90 s fixture cannot test this — every one of its
  // segments is separated from the next by a gap, so it has no shared boundary to
  // stand on (checked below, so this stays true). Whisper on continuous speech
  // does emit abutting segments, so the case is real even though the fixture
  // cannot express it: it needs a synthetic pair, not more fixture assertions.
  it("treats a segment as [start, end) — a boundary time belongs to the later segment", () => {
    const abutting = [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ];

    expect(activeSegmentIndex(abutting, 2)).toBe(1);
    expect(activeSegmentIndex(abutting, 1.999)).toBe(0);
    expect(activeSegmentIndex(abutting, 4)).toBe(NO_ACTIVE_SEGMENT);
  });

  it("has no abutting segments in the fixture — the case above is synthetic for a reason", () => {
    const abutting = fixture.filter((seg, i) => i > 0 && seg.start === fixture[i - 1].end);

    expect(abutting).toHaveLength(0);
  });

  // U6: the reason the fixture has a >=6 s quiet gap. The gap is MEASURED, not
  // hardcoded to an index, so re-cutting the fixture cannot silently move it out
  // from under this test.
  it("returns no active segment inside a quiet gap rather than sticking to the previous one", () => {
    let gapIndex = -1;
    let widest = 0;
    for (let i = 1; i < fixture.length; i++) {
      const gap = fixture[i].start - fixture[i - 1].end;
      if (gap > widest) {
        widest = gap;
        gapIndex = i;
      }
    }
    expect(widest, "fixture must contain a quiet gap for this to test anything").toBeGreaterThanOrEqual(1);

    const insideGap = (fixture[gapIndex - 1].end + fixture[gapIndex].start) / 2;

    expect(activeSegmentIndex(fixture, insideGap)).toBe(NO_ACTIVE_SEGMENT);
  });

  // U8: the fixture's speech starts at 0.6 s, so t=0 is silence — a scan that
  // assumes the first segment starts the video reports index 0 here.
  it("returns no active segment before speech begins", () => {
    expect(fixture[0].start).toBeGreaterThan(0);
    expect(activeSegmentIndex(fixture, 0)).toBe(NO_ACTIVE_SEGMENT);
  });

  it("returns no active segment after the transcript ends", () => {
    const last = fixture[fixture.length - 1];

    expect(activeSegmentIndex(fixture, last.end + 5)).toBe(NO_ACTIVE_SEGMENT);
  });

  it.each([NaN, Infinity])("returns no active segment for a non-finite time (%s)", (time) => {
    // A <video> reports NaN currentTime before metadata loads; that must read as
    // "nothing active", not throw and not match segment 0.
    expect(activeSegmentIndex(fixture, time)).toBe(NO_ACTIVE_SEGMENT);
  });

  it("returns no active segment for an empty transcript", () => {
    expect(activeSegmentIndex([], 1)).toBe(NO_ACTIVE_SEGMENT);
  });
});

describe("sourceVideoUrl", () => {
  it("points at the project's video route", () => {
    expect(sourceVideoUrl(7)).toBe("/api/projects/7/video");
  });
});

describe("captionsDisabledMessage", () => {
  it("explains that a no-audio video cannot be captioned", () => {
    const message = captionsDisabledMessage(false);

    expect(message).toMatch(/no audio/i);
    expect(message).toMatch(/captions are unavailable/i);
  });

  // null means the ingest probe has not run — we do not yet know whether there
  // is audio, so we must not claim captions are unavailable.
  it("stays silent until the probe has decided (null / true)", () => {
    expect(captionsDisabledMessage(null)).toBeNull();
    expect(captionsDisabledMessage(true)).toBeNull();
    expect(captionsDisabledMessage(undefined)).toBeNull();
  });
});

describe("emptyTranscriptMessage", () => {
  it("says nothing when there are sentences to render", () => {
    expect(
      emptyTranscriptMessage({ transcribed: true, statusNote: null, segments: fixture }),
    ).toBeNull();
  });

  // A statusNote alongside real segments is not a reason to suppress them: the
  // note explains an absence, and there is no absence here.
  it("says nothing when there are sentences even if a status note is set", () => {
    expect(
      emptyTranscriptMessage({ transcribed: false, statusNote: NO_AUDIO_NOTE, segments: fixture }),
    ).toBeNull();
  });

  // The whole reason readTranscript answers 200-with-reason instead of 404: the
  // note the transcribe handler wrote has to reach the user. Imported from the
  // handler rather than retyped, so a reworded note cannot leave this green while
  // the panel shows stale copy.
  it("surfaces the handler's own note for a project with no audio", () => {
    expect(emptyTranscriptMessage({ transcribed: false, statusNote: NO_AUDIO_NOTE, segments: [] })).toBe(
      NO_AUDIO_NOTE,
    );
  });

  it("prefers the status note over the transcribed flag when both are present", () => {
    // The disagreeing cell: transcribed=true says "finished", the note says what
    // actually happened. An implementation reading only the flag reports "no
    // speech detected" here and buries the real reason.
    expect(emptyTranscriptMessage({ transcribed: true, statusNote: NO_AUDIO_NOTE, segments: [] })).toBe(
      NO_AUDIO_NOTE,
    );
  });

  it("reports work in progress when the job has not run yet", () => {
    const message = emptyTranscriptMessage({ transcribed: false, statusNote: null, segments: [] });

    expect(message).toMatch(/transcribing/i);
  });

  // Transcribed, no note, no segments is a transcript of silence — a real
  // outcome for an audio track with no speech. Reporting it as "Transcribing…"
  // would promise an update that is never coming.
  it("distinguishes a finished-but-silent transcript from one still running", () => {
    const silent = emptyTranscriptMessage({ transcribed: true, statusNote: null, segments: [] });
    const pending = emptyTranscriptMessage({ transcribed: false, statusNote: null, segments: [] });

    expect(silent).toMatch(/no speech/i);
    expect(silent).not.toBe(pending);
  });

  // A note written as whitespace is an empty note; it must fall through to the
  // flag rather than render a blank box the user cannot interpret.
  it("treats a blank status note as no note at all", () => {
    expect(emptyTranscriptMessage({ transcribed: false, statusNote: "   ", segments: [] })).toMatch(
      /transcribing/i,
    );
  });
});
