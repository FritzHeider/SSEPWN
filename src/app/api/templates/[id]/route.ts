import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { deleteTemplate, getTemplate, renameTemplate } from "@/lib/templates/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

function notFound(id: number) {
  return NextResponse.json({ error: `No template with id ${id}`, code: "not_found" }, { status: 404 });
}

/** Built-ins are undeletable/unrenamable per SPEC — the manage UI locks them and
 * the route refuses them too so a hand-crafted request cannot mutate a built-in. */
function builtinProtected() {
  return NextResponse.json(
    { error: "Built-in templates cannot be modified", code: "builtin_protected" },
    { status: 403 },
  );
}

/**
 * PATCH /api/templates/:id — rename a saved template.
 *
 * Body `{ name: string }`. Built-ins are protected (403); an unknown id is 404;
 * a non-string/blank name is 400. The trim/fallback lives in `renameTemplate`,
 * but we reject a missing name here so the UI gets a clear error rather than a
 * silent "Untitled template".
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return badRequest("Template id must be a positive integer", "invalid_id");

  const existing = getTemplate(db, id);
  if (!existing) return notFound(id);
  if (existing.builtin) return builtinProtected();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Body must be valid JSON", "invalid_body");
  }
  const name = (payload as Record<string, unknown> | null)?.name;
  if (typeof name !== "string" || name.trim() === "") {
    return badRequest("name must be a non-empty string", "invalid_name");
  }

  const template = renameTemplate(db, id, name);
  return NextResponse.json({ template });
}

/**
 * DELETE /api/templates/:id — delete a saved template. Built-ins are protected
 * (403); an unknown id is 404. Response `{ id, deleted: true }`.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return badRequest("Template id must be a positive integer", "invalid_id");

  const existing = getTemplate(db, id);
  if (!existing) return notFound(id);
  if (existing.builtin) return builtinProtected();

  deleteTemplate(db, id);
  return NextResponse.json({ id, deleted: true });
}
