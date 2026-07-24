import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEARTBEAT_STALE_MS,
  deriveHealth,
  readHeartbeatAt,
  writeHeartbeat,
} from "../src/lib/health";

describe("deriveHealth", () => {
  it("is offline with a null lastSeen when there is no heartbeat", () => {
    expect(deriveHealth(null, 1_000_000)).toEqual({ worker: "offline", lastSeenMs: null });
  });

  it("is online while the heartbeat is within the staleness threshold", () => {
    const now = 1_000_000;
    const at = now - (HEARTBEAT_STALE_MS - 1);
    expect(deriveHealth(at, now)).toEqual({ worker: "online", lastSeenMs: at });
  });

  it("is online exactly at the threshold boundary", () => {
    const now = 1_000_000;
    const at = now - HEARTBEAT_STALE_MS;
    expect(deriveHealth(at, now).worker).toBe("online");
  });

  it("is offline once the heartbeat is older than the threshold", () => {
    const now = 1_000_000;
    const at = now - (HEARTBEAT_STALE_MS + 1);
    expect(deriveHealth(at, now)).toEqual({ worker: "offline", lastSeenMs: at });
  });

  it("treats a future heartbeat (clock skew) as online", () => {
    const now = 1_000_000;
    expect(deriveHealth(now + 5_000, now).worker).toBe("online");
  });

  it("reports lastSeenMs as the heartbeat timestamp, not an age", () => {
    expect(deriveHealth(42_000, 50_000).lastSeenMs).toBe(42_000);
  });
});

describe("writeHeartbeat / readHeartbeatAt", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sseclone-heartbeat-"));
    file = path.join(dir, "worker.heartbeat");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the `at` timestamp it wrote", () => {
    writeHeartbeat(1234, 987_654, file);
    expect(readHeartbeatAt(file)).toBe(987_654);
  });

  it("returns null for a missing file (worker never started)", () => {
    expect(readHeartbeatAt(path.join(dir, "nope.heartbeat"))).toBeNull();
  });

  it("falls back to the file mtime when the contents are unreadable", () => {
    writeFileSync(file, "not json");
    const at = readHeartbeatAt(file);
    expect(at).not.toBeNull();
    expect(Math.abs((at as number) - Date.now())).toBeLessThan(5_000);
  });
});
