/**
 * Seed the three built-in templates after migrations run (SPEC.md Phase 09:
 * "Built-in templates seeded on migrate"). Invoked by `npm run db:migrate`
 * right after `drizzle-kit migrate`. Idempotent: safe to run repeatedly — the
 * seed keys on the unique template slug and inserts nothing on a second run.
 */

import { db } from "../src/lib/db";
import { seedBuiltinTemplates } from "../src/lib/templates/builtins";

const inserted = seedBuiltinTemplates(db);
console.log(`Seeded built-in templates (${inserted} inserted, 3 total).`);
