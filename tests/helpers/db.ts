import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as schema from "../../src/lib/db/schema";
import { projects } from "../../src/lib/db/schema";
import type { JobsDb } from "../../src/lib/jobs";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface TestDb {
  db: JobsDb;
  /** Path to the database file, for opening a second connection. */
  file: string;
  close(): void;
}

function connect(file: string): { db: JobsDb; close: () => void } {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}

/** A migrated database in a throwaway temp directory. */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(path.join(tmpdir(), "sseclone-test-"));
  const file = path.join(dir, "test.db");
  const { db, close } = connect(file);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    file,
    close: () => {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A second, independent connection to an existing test database. */
export function openTestDb(file: string): TestDb {
  const { db, close } = connect(file);
  return { db, file, close };
}

/** Jobs require a project (foreign key); returns the new project id. */
export function seedProject(db: JobsDb, name = "test project"): number {
  const [row] = db.insert(projects).values({ name }).returning({ id: projects.id }).all();
  return row.id;
}
