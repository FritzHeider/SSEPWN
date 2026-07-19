import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiError, invalidId, notFound, parseJsonBody } from "../src/lib/api/errors";

/**
 * The shared API error shape and zod body front door. These are the invariants
 * every route now leans on — one `{ error, code }` object, an honest status, and
 * two distinct codes for "not JSON" vs "failed the schema" — so they are pinned
 * here once instead of re-proven in every route test.
 */

/** Build a Request whose body is exactly `raw` (bypasses JSON.stringify so we
 * can feed deliberately malformed bytes). */
function jsonRequest(raw: string): Request {
  return new Request("http://test/api", { method: "POST", body: raw });
}

describe("apiError / invalidId / notFound", () => {
  it("emits the canonical { error, code } body with the given status", async () => {
    const res = apiError(422, "teapot", "short and stout");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "short and stout", code: "teapot" });
  });

  it("invalidId is a 400 with code invalid_id and the labelled entity", async () => {
    const res = invalidId("Clip");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("invalid_id");
    expect(body.error).toContain("Clip id");
  });

  it("notFound is a 404 with code not_found naming the entity and id", async () => {
    const res = notFound("project", 7);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("not_found");
    expect(body.error).toBe("No project with id 7");
  });
});

describe("parseJsonBody", () => {
  const schema = z.object({ n: z.number().refine((x) => x > 0, "n must be positive") });

  it("returns the parsed data on a valid body", async () => {
    const result = await parseJsonBody(jsonRequest(JSON.stringify({ n: 3 })), schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ n: 3 });
  });

  it("rejects a non-JSON body as 400 invalid_body regardless of schemaCode", async () => {
    const result = await parseJsonBody(jsonRequest("{not json"), schema, { schemaCode: "invalid_range" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(((await result.response.json()) as { code: string }).code).toBe("invalid_body");
    }
  });

  it("maps a schema violation to the supplied schemaCode with the zod message", async () => {
    const result = await parseJsonBody(jsonRequest(JSON.stringify({ n: -1 })), schema, {
      schemaCode: "invalid_range",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = (await result.response.json()) as { error: string; code: string };
      expect(result.response.status).toBe(400);
      expect(body.code).toBe("invalid_range");
      expect(body.error).toContain("n must be positive");
    }
  });

  it("defaults a schema violation to invalid_body when no schemaCode is given", async () => {
    const result = await parseJsonBody(jsonRequest(JSON.stringify({ n: "x" })), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(((await result.response.json()) as { code: string }).code).toBe("invalid_body");
    }
  });
});
