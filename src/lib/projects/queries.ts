import { desc } from "drizzle-orm";

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
  return db.select().from(projects).orderBy(desc(projects.createdAt), desc(projects.id)).all();
}
