import { desc, getTableColumns, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";

/**
 * Every project, newest first — shared by `GET /api/projects` and the `/` page's
 * server-rendered first paint, so both agree on order by construction.
 *
 * The tiebreak on `id` is load-bearing, not decoration: `created_at` is unixepoch
 * SECONDS, so projects uploaded within the same second collide and
 * `ORDER BY created_at DESC` alone leaves their order up to SQLite (two
 * back-to-back uploads really did land on the same second in a real-server
 * check). The list polls, so an unstable sort would visibly shuffle rows between
 * refreshes. `id` is a monotonic autoincrement, which makes it the tiebreak that
 * matches "newest first".
 */
export function listProjects() {
  // Counts come from correlated scalar subqueries, not a join+group-by: exports
  // reach the project only through clips, so a two-level join would multiply the
  // clip count by the export count (and vice versa). A subquery per card column
  // stays exact and reads as what it computes.
  //
  // The identifiers are written fully qualified as literals rather than
  // interpolated columns: drizzle emits an interpolated `${projects.id}` inside a
  // raw `sql` subquery UNqualified ("id"), which SQLite then binds to the inner
  // `clips` scope — silently correlating `clips.project_id = clips.id` and
  // undercounting. Spelling out `"projects"."id"` keeps the correlation honest.
  return db
    .select({
      ...getTableColumns(projects),
      clipCount: sql<number>`(select count(*) from "clips" where "clips"."project_id" = "projects"."id")`,
      exportCount: sql<number>`(select count(*) from "exports" where "exports"."clip_id" in (select "id" from "clips" where "clips"."project_id" = "projects"."id"))`,
    })
    .from(projects)
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .all();
}
