import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeTranscriber } from "@/lib/transcribe/fake";
import {
  createTranscriber,
  selectTranscriberKind,
  type TranscriberEnv,
} from "@/lib/transcribe/factory";
import { WhisperCppTranscriber } from "@/lib/transcribe/whisper";

/**
 * NOTE: no test here calls `transcribe()` on the whisper side. Phase-03 requires
 * the default suite to pass with no whisper binary installed; the constructor
 * only reads env strings, so `instanceof` is the whole assertion.
 */

describe("selectTranscriberKind", () => {
  // The matrix's whole point is the cells where TRANSCRIBER and NODE_ENV
  // DISAGREE. Testing only the agreeing cells would pass a factory that reads
  // just one of the two variables and ignores the other entirely.
  const cases: Array<{ env: TranscriberEnv; expected: string; why: string }> = [
    { env: { TRANSCRIBER: "fake", NODE_ENV: "test" }, expected: "fake", why: "agree" },
    { env: { TRANSCRIBER: "whisper", NODE_ENV: "production" }, expected: "whisper", why: "agree" },
    {
      env: { TRANSCRIBER: "whisper", NODE_ENV: "test" },
      expected: "whisper",
      why: "explicit TRANSCRIBER overrides the test default",
    },
    {
      env: { TRANSCRIBER: "fake", NODE_ENV: "production" },
      expected: "fake",
      why: "explicit TRANSCRIBER overrides the dev default",
    },
    { env: { NODE_ENV: "test" }, expected: "fake", why: "default under test" },
    { env: { NODE_ENV: "development" }, expected: "whisper", why: "default in dev" },
    { env: { NODE_ENV: "production" }, expected: "whisper", why: "default in prod" },
    { env: {}, expected: "whisper", why: "no NODE_ENV at all is not test" },
  ];

  for (const { env, expected, why } of cases) {
    it(`TRANSCRIBER=${env.TRANSCRIBER ?? "<unset>"} NODE_ENV=${env.NODE_ENV ?? "<unset>"} -> ${expected} (${why})`, () => {
      expect(selectTranscriberKind(env)).toBe(expected);
    });
  }

  it("treats an exported-but-empty TRANSCRIBER as unset", () => {
    expect(selectTranscriberKind({ TRANSCRIBER: "", NODE_ENV: "test" })).toBe("fake");
    expect(selectTranscriberKind({ TRANSCRIBER: "   ", NODE_ENV: "development" })).toBe("whisper");
  });

  it("tolerates surrounding whitespace and casing", () => {
    expect(selectTranscriberKind({ TRANSCRIBER: " fake ", NODE_ENV: "production" })).toBe("fake");
    expect(selectTranscriberKind({ TRANSCRIBER: "WHISPER", NODE_ENV: "test" })).toBe("whisper");
  });

  it("rejects an unrecognised TRANSCRIBER instead of falling back", () => {
    // A silent fallback would let `TRANSCRIBER=faker` spawn real whisper.cpp in
    // the test suite — the failure this default exists to prevent.
    expect(() => selectTranscriberKind({ TRANSCRIBER: "faker", NODE_ENV: "test" })).toThrow(
      /Invalid TRANSCRIBER/,
    );
  });

  it("names the offending value and both valid options in the error", () => {
    let message = "";
    try {
      selectTranscriberKind({ TRANSCRIBER: "Fak3", NODE_ENV: "test" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Fak3");
    expect(message).toContain('"fake"');
    expect(message).toContain('"whisper"');
  });
});

describe("createTranscriber", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a FakeTranscriber for TRANSCRIBER=fake", () => {
    expect(createTranscriber({ TRANSCRIBER: "fake", NODE_ENV: "production" })).toBeInstanceOf(
      FakeTranscriber,
    );
  });

  it("builds a WhisperCppTranscriber for TRANSCRIBER=whisper, even under NODE_ENV=test", () => {
    // Also proves the injected env is what is read: the ambient NODE_ENV really
    // is "test" here (vitest sets it), so a factory ignoring its argument would
    // hand back a FakeTranscriber.
    expect(process.env.NODE_ENV).toBe("test");
    expect(createTranscriber({ TRANSCRIBER: "whisper", NODE_ENV: "test" })).toBeInstanceOf(
      WhisperCppTranscriber,
    );
  });

  it("propagates the invalid-value error rather than constructing a default", () => {
    expect(() => createTranscriber({ TRANSCRIBER: "nope" })).toThrow(/Invalid TRANSCRIBER/);
  });

  // The no-arg calls below cover the `= process.env` default itself. The injected
  // cases above cannot see it dropped, and these cannot see the argument ignored
  // — the pair is what pins both halves.
  it("reads process.env when called with no argument", () => {
    vi.stubEnv("TRANSCRIBER", "whisper");
    expect(createTranscriber()).toBeInstanceOf(WhisperCppTranscriber);

    vi.stubEnv("TRANSCRIBER", "fake");
    expect(createTranscriber()).toBeInstanceOf(FakeTranscriber);
  });

  it("defaults to the fake under the suite's own environment", () => {
    // The phase-03 guard, asserted against the real ambient env rather than a
    // synthetic one: `npm test` with no TRANSCRIBER set must never reach whisper.
    vi.stubEnv("TRANSCRIBER", "");
    expect(createTranscriber()).toBeInstanceOf(FakeTranscriber);
  });
});
