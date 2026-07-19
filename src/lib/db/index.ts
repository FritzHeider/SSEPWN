import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import * as schema from "./schema";

const DB_PATH = process.env.SSECLONE_DB_PATH ?? path.join("data", "sseclone.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
// The worker (`npm run worker`) and the Next server are always separate OS
// processes holding their own connections to this one file. WAL lets them read
// concurrently, but a write that collides with another process's write returns
// SQLITE_BUSY immediately unless a busy timeout is set. Give a colliding writer
// up to 5s to acquire the lock instead of throwing — the pipeline's cross-process
// job claims and status updates (and the Phase-11 full-journey e2e, the first
// place two processes write this file at once) depend on it.
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });
export { schema };
