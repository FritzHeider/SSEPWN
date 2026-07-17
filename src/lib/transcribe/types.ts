/**
 * Transcription contract (SPEC.md § Tech stack: whisper.cpp behind a
 * `Transcriber` interface). Everything downstream — Phase 04 highlight
 * scoring, Phase 05 captions — reads these types, never a whisper-specific
 * shape, so the fake and the real binary are interchangeable.
 */

/** One word with its own timing. Captions and karaoke highlighting need this. */
export interface TranscriptWord {
  word: string;
  /** Seconds from the start of the source media. */
  start: number;
  end: number;
}

/** A sentence-ish chunk of speech, carrying the words it is made of. */
export interface TranscriptSegment {
  text: string;
  /** Seconds from the start of the source media. */
  start: number;
  end: number;
  words: TranscriptWord[];
}

export interface Transcriber {
  /**
   * Transcribe an audio or video file into timed segments.
   *
   * Implementations must reject with an actionable Error (naming the missing
   * binary, model, or file) rather than resolving to an empty transcript, so a
   * misconfigured environment fails loudly instead of looking like silence.
   */
  transcribe(audioPath: string): Promise<TranscriptSegment[]>;
}
