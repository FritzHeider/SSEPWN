import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readCaptionDoc } from "../src/lib/captions/edit";
import { buildCropState, readCropState, withCropState } from "../src/lib/crop/state";
import { clipEdits, clips, jobs, projects, templates } from "../src/lib/db/schema";
import { insertTemplate, listTemplates } from "../src/lib/templates/db";
import { seedBuiltinTemplates } from "../src/lib/templates/builtins";
import { createTestDb, type TestDb } from "./helpers/db";

type ParamHandler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

let applyPOST: ParamHandler;
let applyDELETE: ParamHandler;
let savePOST: ParamHandler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function apply(id: string, body: unknown, raw = false): Promise<Response> {
  return applyPOST(
    new Request(`http://localhost/api/clips/${id}/apply-template`, {
      method: "POST",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function undo(id: string): Promise<Response> {
  return applyDELETE(
    new Request(`http://localhost/api/clips/${id}/apply-template`, { method: "DELETE" }),
    ctx(id),
  );
}

function save(id: string, body?: unknown): Promise<Response> {
  return savePOST(
    new Request(`http://localhost/api/clips/${id}/save-as-template`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ctx(id),
  );
}

/** Seed one project + one clip; return ids. */
function seedClip(): { clipId: number; projectId: number } {
  const [project] = testDb.db
    .insert(projects)
    .values({
      name: "tpl project",
      sourceVideoPath: "/tmp/x.mp4",
      duration: 10,
      width: 1280,
      height: 720,
    })
    .returning({ id: projects.id })
    .all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return { clipId: clip.id, projectId: project.id };
}

function storedState(clipId: number): Record<string, unknown> | null {
  const row = testDb.db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  return row ? (JSON.parse(row.state) as Record<string, unknown>) : null;
}

/** Insert a template with the given aspect ratio; return its id. */
function seedTemplate(aspectRatio: "9:16" | "1:1" | "16:9", name = "t"): number {
  const t = insertTemplate(testDb.db, {
    name,
    captionPreset: "bold-pop",
    aspectRatio,
    brandPrimary: "#ff0055",
    brandSecondary: "#111111",
    ctas: [
      {
        variant: "text",
        content: "Follow for more",
        position: "bottom-center",
        start: 0,
        end: 3,
        animIn: "fade",
        animOut: "fade",
      },
    ],
  });
  return t.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ POST: applyPOST, DELETE: applyDELETE } = (await import(
    "../src/app/api/clips/[id]/apply-template/route"
  )) as unknown as { POST: ParamHandler; DELETE: ParamHandler });
  ({ POST: savePOST } = (await import(
    "../src/app/api/clips/[id]/save-as-template/route"
  )) as unknown as { POST: ParamHandler });
});

afterEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
  testDb.db.delete(templates).run();
});

afterAll(() => {
  testDb.close();
});

describe("POST /api/clips/:id/apply-template", () => {
  it("applies caption style + CTA and records the templateId", async () => {
    const { clipId } = seedClip();
    const templateId = seedTemplate("9:16");
    const res = await apply(String(clipId), { templateId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clipId: number; templateId: number };
    expect(body).toMatchObject({ clipId, templateId });

    const state = storedState(clipId)!;
    expect(state.templateId).toBe(templateId);
    const captions = readCaptionDoc(state);
    expect(captions!.style.highlightColor).toBe("#ff0055");
  });

  it("enqueues a smart-crop when the AR needs re-derivation (no prior crop)", async () => {
    const { clipId, projectId } = seedClip();
    const templateId = seedTemplate("9:16");
    const res = await apply(String(clipId), { templateId });
    const body = (await res.json()) as { job: { id: number; type: string; projectId: number } | null };
    expect(body.job).not.toBeNull();
    expect(body.job!.type).toBe("smart-crop");
    expect(body.job!.projectId).toBe(projectId);
    const row = testDb.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, body.job!.id)).get();
    expect(JSON.parse(row!.payload!)).toEqual({ clipId, aspectRatio: "9:16" });
  });

  it("does NOT enqueue a smart-crop when a locked crop keeps the same AR", async () => {
    const { clipId } = seedClip();
    // Pre-lock a 9:16 manual crop.
    const locked = buildCropState("9:16", [{ t: 0, x: 0, y: 0, w: 405, h: 720 }], 1280, 720, true);
    testDb.db.insert(clipEdits).values({ clipId, state: JSON.stringify(withCropState({}, locked)) }).run();

    const templateId = seedTemplate("9:16");
    const res = await apply(String(clipId), { templateId });
    const body = (await res.json()) as { job: unknown };
    expect(body.job).toBeNull();
    expect(testDb.db.select().from(jobs).all()).toHaveLength(0);
    // Locked keyframes survive.
    expect(readCropState(storedState(clipId)!)!.keyframes).toHaveLength(1);
  });

  it("404s for an unknown template and unknown clip; 400s a bad templateId", async () => {
    const { clipId } = seedClip();
    expect((await apply(String(clipId), { templateId: 99999 })).status).toBe(404);
    expect((await apply("99999", { templateId: 1 })).status).toBe(404);
    expect((await apply(String(clipId), { templateId: "x" })).status).toBe(400);
    expect((await apply(String(clipId), "{bad", true)).status).toBe(400);
  });
});

describe("DELETE /api/clips/:id/apply-template (undo)", () => {
  it("restores the exact previous clip_edits blob", async () => {
    const { clipId } = seedClip();
    const before = { captions: { cues: [{ id: 1 }], style: { highlightColor: "#0000ff" } } };
    testDb.db.insert(clipEdits).values({ clipId, state: JSON.stringify(before) }).run();

    const templateId = seedTemplate("1:1");
    await apply(String(clipId), { templateId });
    expect(storedState(clipId)!.templateId).toBe(templateId); // changed

    const res = await undo(String(clipId));
    expect(res.status).toBe(200);
    expect(storedState(clipId)).toEqual(before);
  });

  it("409s when there is nothing to undo", async () => {
    const { clipId } = seedClip();
    const res = await undo(String(clipId));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/clips/:id/save-as-template", () => {
  it("saves the clip's look and round-trips its caption style to another clip", async () => {
    const a = seedClip();
    const templateId = seedTemplate("9:16", "source-look");
    await apply(String(a.clipId), { templateId });
    const aStyle = readCaptionDoc(storedState(a.clipId)!)!.style;

    // Save clip A's current look as a new template.
    const saveRes = await save(String(a.clipId), { name: "My Look" });
    expect(saveRes.status).toBe(201);
    const saved = (await saveRes.json()) as { template: { id: number; name: string; builtin: boolean } };
    expect(saved.template.name).toBe("My Look");
    expect(saved.template.builtin).toBe(false);

    // Apply it to a fresh clip B; B's caption style deep-equals A's.
    const b = seedClip();
    await apply(String(b.clipId), { templateId: saved.template.id });
    const bStyle = readCaptionDoc(storedState(b.clipId)!)!.style;
    expect(bStyle).toEqual(aStyle);
  });

  it("defaults the name and accepts an empty body", async () => {
    const { clipId } = seedClip();
    const res = await save(String(clipId));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { template: { name: string } };
    expect(body.template.name).toBe("Untitled template");
  });

  it("404s for an unknown clip", async () => {
    expect((await save("99999", { name: "x" })).status).toBe(404);
  });

  it("a saved template shows up in listTemplates alongside seeded built-ins", async () => {
    seedBuiltinTemplates(testDb.db);
    const { clipId } = seedClip();
    await save(String(clipId), { name: "Mine" });
    const all = listTemplates(testDb.db);
    expect(all.filter((t) => t.builtin)).toHaveLength(3);
    expect(all.some((t) => !t.builtin && t.name === "Mine")).toBe(true);
  });
});
