import { createServer } from "node:http";

import next from "next";

import { db } from "../src/lib/db";
import { createJobQueue } from "../src/lib/jobs";
import { handlers } from "../src/worker/handlers";
import { createWorker } from "../src/worker/loop";

/**
 * Custom server for the Playwright e2e run: it serves the PRODUCTION Next build
 * (`next({ dev: false })`, so hydration is as deterministic as `next start` —
 * dev-mode on-demand compilation drops client handlers the split/delete flow
 * needs) AND runs the pipeline worker loop IN THE SAME PROCESS.
 *
 * Why in-process: the full-journey spec uploads a fixture and waits for the
 * ingest → transcribe → generate-clips chain, then for an export render. On this
 * platform a `next start` server's SQLite writes are not visible to a SEPARATE
 * worker process (its WAL commits never surface for another process to read, and
 * a rollback journal makes the server error "readonly database"). Running the
 * worker here means the HTTP handlers and the worker share the one `db` singleton
 * connection, so every enqueue is immediately visible to the worker and every
 * result immediately visible to the UI — exactly the guarantee a single Node
 * process gives, without depending on cross-process journal sharing.
 *
 * `TRANSCRIBER=fake` (set by playwright.config's webServer env) keeps transcribe
 * replaying the checked-in fixture transcript instead of calling real whisper.
 */
const port = Number(process.env.PORT ?? 3123);

// A browser that aborts an in-flight streamed response (a poll, a video range
// request) can surface late in Next as an unhandled "Controller is already
// closed" error. That is harmless to the request but would, by default, take
// down this whole server mid-test. Log and keep serving.
process.on("uncaughtException", (error) => {
  console.error("[e2e-server] uncaughtException (ignored):", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[e2e-server] unhandledRejection (ignored):", reason);
});

async function main(): Promise<void> {
  const app = next({ dev: false });
  await app.prepare();
  const handle = app.getRequestHandler();

  const worker = createWorker({
    queue: createJobQueue(db),
    db,
    handlers,
    pollMs: 250,
  });
  void worker.start();

  createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("[e2e-server] request failed:", error);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    });
  }).listen(port, () => {
    console.log(`[e2e-server] production app + in-process worker ready on :${port}`);
  });
}

main().catch((error: unknown) => {
  console.error("[e2e-server] fatal:", error);
  process.exit(1);
});
