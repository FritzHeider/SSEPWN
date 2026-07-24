import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeHeartbeat } from "../src/lib/health";

type Handler = () => Promise<Response>;

let healthGET: Handler;
let dir: string;
let heartbeatFile: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sseclone-health-"));
  heartbeatFile = path.join(dir, "worker.heartbeat");
  process.env.SSECLONE_HEARTBEAT_PATH = heartbeatFile;
  ({ GET: healthGET } = (await import("../src/app/api/health/route")) as unknown as { GET: Handler });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SSECLONE_HEARTBEAT_PATH;
});

describe("GET /api/health", () => {
  it("reports offline with a null lastSeen when there is no heartbeat", async () => {
    try {
      unlinkSync(heartbeatFile);
    } catch {
      /* already absent */
    }
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ worker: "offline", lastSeenMs: null });
  });

  it("reports online with the timestamp for a fresh heartbeat", async () => {
    const now = Date.now();
    writeHeartbeat(process.pid, now, heartbeatFile);
    const body = (await (await healthGET()).json()) as { worker: string; lastSeenMs: number };
    expect(body.worker).toBe("online");
    expect(body.lastSeenMs).toBe(now);
  });

  it("reports offline for a stale heartbeat", async () => {
    writeHeartbeat(process.pid, Date.now() - 60_000, heartbeatFile);
    const body = (await (await healthGET()).json()) as { worker: string };
    expect(body.worker).toBe("offline");
  });

  it("never 500s", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
  });
});
