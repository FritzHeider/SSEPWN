import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { listTemplates } from "@/lib/templates/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/templates — the full template gallery: built-ins first (in seed
 * order), then user-saved templates newest-last, exactly as {@link listTemplates}
 * orders them. The clip editor's template panel and the manage page both read
 * this. Everything returned is already boundary-validated by `rowToTemplate`, so
 * a hand-corrupted row can never reach the UI.
 */
export async function GET() {
  return NextResponse.json({ templates: listTemplates(db) });
}
