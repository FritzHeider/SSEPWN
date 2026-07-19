/**
 * The one JSON error shape every route speaks, and the zod front door for
 * request bodies (global rule: validate input at system boundaries).
 *
 * Every handler in `src/app/api` answers a rejected request with the same
 * `{ error, code }` object and an honest HTTP status: `error` is a human string
 * that may change freely, `code` is the stable machine tag clients and tests
 * branch on. Centralising the constructor here is what keeps those two facts
 * true across two-dozen routes — a hand-rolled `NextResponse.json` in one file
 * is exactly how a shape drifts.
 */
import { NextResponse } from "next/server";
import type { ZodType } from "zod";

/** The body of every non-2xx API response. `code` is the stable, tested tag. */
export interface ApiErrorBody {
  error: string;
  code: string;
}

/** Build the canonical error response. Status and code travel together so a 404
 * can never accidentally ship a `code: "invalid_body"`. */
export function apiError(status: number, code: string, message: string): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, code }, { status });
}

/** 400 for a malformed `:id` path segment (see {@link parseId}). `label` names
 * the entity so the message reads "Clip id …" / "Project id …". */
export function invalidId(label = "Resource"): NextResponse<ApiErrorBody> {
  return apiError(400, "invalid_id", `${label} id must be a positive integer`);
}

/** 404 for a well-formed id that matched no row. */
export function notFound(entity: string, id: number | string): NextResponse<ApiErrorBody> {
  return apiError(404, "not_found", `No ${entity} with id ${id}`);
}

/**
 * The result of validating a request body: either the parsed value, or a ready
 * 400 response to return. Callers pattern-match on `ok` so the happy path keeps
 * a fully-typed `data` and the error path is a single `return result.response`.
 */
export type BodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<ApiErrorBody> };

/** Read a JSON body against a zod schema, mapping the two distinct failures to
 * two distinct codes. */
export interface ParseBodyOptions {
  /**
   * Code for a body that is valid JSON but fails the schema. Defaults to
   * `"invalid_body"`; routes that have a more specific tag for a bad payload
   * (e.g. a range route uses `"invalid_range"`) pass it here so clients keep
   * getting the precise code they branch on.
   */
  schemaCode?: string;
}

/**
 * Parse and validate a request JSON body with a zod schema.
 *
 * Two failure modes, two codes, on purpose: a body that isn't JSON at all is
 * `invalid_body` (the request never carried a document to validate), while a
 * well-formed JSON document that violates the schema is `schemaCode` (defaulting
 * to `invalid_body`). Keeping them apart is what lets a caller answer "you sent
 * garbage" and "your range is backwards" with different, testable codes from one
 * helper. The zod issue message is surfaced verbatim so the response explains
 * *what* was wrong without the route restating the schema by hand.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  options: ParseBodyOptions = {},
): Promise<BodyResult<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: apiError(400, "invalid_body", "Body must be valid JSON") };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const code = options.schemaCode ?? "invalid_body";
    return { ok: false, response: apiError(400, code, firstIssueMessage(parsed.error)) };
  }

  return { ok: true, data: parsed.data };
}

/** First zod issue as a flat "path: message" string, or a bare message at the
 * root. One line is enough for an API error; the full tree helps no client. */
function firstIssueMessage(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
