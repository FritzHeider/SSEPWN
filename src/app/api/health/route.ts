import { NextResponse } from "next/server";

import { deriveHealth, readHeartbeatAt } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — is the media worker alive?
 *
 * Reads the heartbeat file the worker refreshes each poll iteration and reports
 * `online`/`offline` from its staleness, plus the epoch-ms timestamp it was last
 * seen (`null` when there is no heartbeat at all). Never 500s: a missing or
 * unreadable file reads as offline, which is the honest answer when no worker is
 * running.
 */
export async function GET() {
  const health = deriveHealth(readHeartbeatAt(), Date.now());
  return NextResponse.json(health);
}
