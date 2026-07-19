import { prepareSeedDb } from "./seed";

/**
 * Playwright global setup — runs exactly once in the runner process, before the
 * webServer starts and before any worker spawns.
 *
 * The seed MUST live here, not at `playwright.config.ts` module scope: Playwright
 * re-imports the config file in every worker process to reconstruct its settings,
 * so a top-level `prepareSeedDb()` re-runs mid-suite and wipes the shared e2e DB
 * out from under the already-running webServer. That is invisible to specs that
 * only read the seeded rows (a re-seed reproduces them identically), but it
 * silently deletes anything a spec writes at runtime — e.g. the full-journey
 * spec's uploaded project. `globalSetup` runs once, so the DB is seeded before
 * the server opens it and never re-wiped while tests run.
 */
export default function globalSetup(): void {
  prepareSeedDb();
}
