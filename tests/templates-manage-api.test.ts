import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { templates } from "../src/lib/db/schema";
import { seedBuiltinTemplates } from "../src/lib/templates/builtins";
import { getTemplate, insertTemplate, listTemplates } from "../src/lib/templates/db";
import { createTestDb, type TestDb } from "./helpers/db";

type IdHandler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

let listGET: () => Promise<Response>;
let renamePATCH: IdHandler;
let deleteDELETE: IdHandler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function rename(id: string, body: unknown, raw = false): Promise<Response> {
  return renamePATCH(
    new Request(`http://localhost/api/templates/${id}`, {
      method: "PATCH",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function remove(id: string): Promise<Response> {
  return deleteDELETE(
    new Request(`http://localhost/api/templates/${id}`, { method: "DELETE" }),
    ctx(id),
  );
}

/** Insert a user-saved template; return its id. */
function seedSaved(name = "Saved"): number {
  return insertTemplate(testDb.db, {
    name,
    captionPreset: "bold-pop",
    aspectRatio: "9:16",
    brandPrimary: "#ff0055",
    brandSecondary: "#111111",
    ctas: [],
  }).id;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: listGET } = (await import("../src/app/api/templates/route")) as unknown as {
    GET: () => Promise<Response>;
  });
  ({ PATCH: renamePATCH, DELETE: deleteDELETE } = (await import(
    "../src/app/api/templates/[id]/route"
  )) as unknown as { PATCH: IdHandler; DELETE: IdHandler });
});

afterEach(() => {
  testDb.db.delete(templates).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/templates", () => {
  it("returns built-ins first, then saved templates", async () => {
    seedBuiltinTemplates(testDb.db);
    seedSaved("Mine");
    const res = await listGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: { name: string; builtin: boolean }[] };
    expect(body.templates).toHaveLength(4);
    expect(body.templates.slice(0, 3).every((t) => t.builtin)).toBe(true);
    expect(body.templates[3]).toMatchObject({ name: "Mine", builtin: false });
  });

  it("returns an empty list when there are no templates", async () => {
    const body = (await (await listGET()).json()) as { templates: unknown[] };
    expect(body.templates).toEqual([]);
  });
});

describe("PATCH /api/templates/:id (rename)", () => {
  it("renames a saved template", async () => {
    const id = seedSaved("Old");
    const res = await rename(String(id), { name: "New name" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { name: string } };
    expect(body.template.name).toBe("New name");
    expect(getTemplate(testDb.db, id)!.name).toBe("New name");
  });

  it("refuses to rename a built-in (403) and leaves it untouched", async () => {
    seedBuiltinTemplates(testDb.db);
    const builtin = listTemplates(testDb.db).find((t) => t.builtin)!;
    const res = await rename(String(builtin.id), { name: "Hacked" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("builtin_protected");
    expect(getTemplate(testDb.db, builtin.id)!.name).toBe(builtin.name);
  });

  it("400s a blank/missing name and 404s an unknown id", async () => {
    const id = seedSaved();
    expect((await rename(String(id), { name: "   " })).status).toBe(400);
    expect((await rename(String(id), {})).status).toBe(400);
    expect((await rename(String(id), "{bad", true)).status).toBe(400);
    expect((await rename("99999", { name: "x" })).status).toBe(404);
  });
});

describe("DELETE /api/templates/:id", () => {
  it("deletes a saved template", async () => {
    const id = seedSaved();
    const res = await remove(String(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(getTemplate(testDb.db, id)).toBeNull();
  });

  it("refuses to delete a built-in (403) and keeps it", async () => {
    seedBuiltinTemplates(testDb.db);
    const builtin = listTemplates(testDb.db).find((t) => t.builtin)!;
    const res = await remove(String(builtin.id));
    expect(res.status).toBe(403);
    expect(getTemplate(testDb.db, builtin.id)).not.toBeNull();
  });

  it("404s an unknown id", async () => {
    expect((await remove("99999")).status).toBe(404);
  });
});
