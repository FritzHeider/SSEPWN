import Link from "next/link";

import { ManageList } from "./_components/manage-list";
import { db } from "@/lib/db";
import { listTemplates } from "@/lib/templates/db";

// Reads the `templates` table per request; nothing here is static.
export const dynamic = "force-dynamic";

/**
 * `/templates` — the template manage page (Phase 09). Lists built-in and saved
 * templates; built-ins are read-only, saved templates can be renamed or deleted.
 * The DB is read directly (like the other pages); mutations go through the
 * `/api/templates/:id` routes from the client list.
 */
export default function TemplatesManagePage() {
  const templates = listTemplates(db);
  const savedCount = templates.filter((t) => !t.builtin).length;

  return (
    <div className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← Home
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Templates
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {templates.length} template{templates.length === 1 ? "" : "s"} · {savedCount} saved.
            Built-ins are read-only.
          </p>
        </header>

        <ManageList templates={templates} />
      </main>
    </div>
  );
}
