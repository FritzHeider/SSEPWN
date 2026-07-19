import { defineConfig, devices } from "@playwright/test";

import { SEED_DB_PATH, prepareSeedDb } from "./e2e/seed";

/**
 * Phase-07 Playwright config: drive the real editor in a headless Chromium
 * against a Next dev server backed by a dedicated, freshly seeded SQLite file.
 *
 * The seed runs HERE, at config load — before the webServer launches and before
 * any test — so the Next process only ever opens an already-migrated, already-
 * seeded database. Both the seeder and the server read the same
 * `SSECLONE_DB_PATH`, the env var `src/lib/db/index.ts` honours.
 *
 * Kept separate from the vitest suite: vitest only globs `*.test.ts` under
 * `tests/`+`src/` (see vitest.config.ts), so these `e2e/*.spec.ts` files never
 * run there and vice versa.
 */
prepareSeedDb();

const PORT = 3123;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A production build + start, not `next dev`: dev-mode on-demand compilation
    // and HMR hydrate unreliably in headless CI (and collide with a stale prod
    // `.next` left by the build gate), which silently drops the client handlers
    // the split/delete flow depends on. `next start` serves a freshly built,
    // deterministically hydrating bundle.
    command: `next build && next start -p ${PORT}`,
    url: BASE_URL,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { SSECLONE_DB_PATH: SEED_DB_PATH },
  },
});
