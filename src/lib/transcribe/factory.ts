import { FakeTranscriber } from "./fake";
import type { Transcriber } from "./types";
import { WhisperCppTranscriber } from "./whisper";

/** The transcriber implementations `TRANSCRIBER` can name. */
export type TranscriberKind = "fake" | "whisper";

const KINDS: readonly TranscriberKind[] = ["fake", "whisper"];

/** Subset of the environment the selection depends on. */
export type TranscriberEnv = Partial<Record<"TRANSCRIBER" | "NODE_ENV", string>>;

function isKind(value: string): value is TranscriberKind {
  return (KINDS as readonly string[]).includes(value);
}

/**
 * Decide which transcriber to use: explicit `TRANSCRIBER=fake|whisper` wins,
 * otherwise fake under test and whisper everywhere else (phase-03: the default
 * suite must pass with no whisper binary installed and no network).
 *
 * An unrecognised value is an error rather than a fallback. Falling back would
 * mean a typo like `TRANSCRIBER=faker` silently spawns real whisper.cpp — the
 * exact thing the test default exists to prevent — and the failure would surface
 * far away as an opaque missing-binary error.
 */
export function selectTranscriberKind(env: TranscriberEnv = process.env): TranscriberKind {
  const requested = env.TRANSCRIBER?.trim().toLowerCase();

  // An exported-but-empty var is "unset" as far as a shell user is concerned.
  if (!requested) {
    return env.NODE_ENV === "test" ? "fake" : "whisper";
  }

  if (!isKind(requested)) {
    throw new Error(
      `Invalid TRANSCRIBER="${env.TRANSCRIBER}" — expected ${KINDS.map((k) => `"${k}"`).join(" or ")}. ` +
        `Unset it to get the default ("fake" under NODE_ENV=test, otherwise "whisper"). ` +
        `See README.md § Transcription.`,
    );
  }

  return requested;
}

/**
 * Build the configured `Transcriber`.
 *
 * Only the class is chosen here: each implementation already resolves its own
 * config (`WHISPER_BIN`/`WHISPER_MODEL`, the transcript fixture dir) from its
 * defaults, so this stays a single decision with a single reason to change.
 */
export function createTranscriber(env: TranscriberEnv = process.env): Transcriber {
  return selectTranscriberKind(env) === "fake"
    ? new FakeTranscriber()
    : new WhisperCppTranscriber();
}
