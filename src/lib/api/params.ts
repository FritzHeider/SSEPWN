/**
 * Route param validation (global rule: validate input at system boundaries).
 *
 * `:id` segments arrive as arbitrary strings. Coercing them with Number() and
 * handing the result straight to a query lets `NaN` reach SQLite, which answers
 * "no rows" and turns a malformed request into a misleading 404 — or, with
 * drizzle's typed builders, a 500. Both hide the client's actual mistake, so
 * ids are parsed and rejected here instead.
 */
export function parseId(raw: string): number | null {
  // Number() would accept ' 12 ', '1e3', '0x0c' and '12.0'; row ids are plain
  // positive integers and nothing else.
  if (!/^[1-9][0-9]*$/.test(raw)) return null;

  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
