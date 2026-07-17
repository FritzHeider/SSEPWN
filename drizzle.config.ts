import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Same override as src/lib/db/index.ts — otherwise `SSECLONE_DB_PATH=x
    // npm run db:migrate` silently migrates the default database instead.
    url: process.env.SSECLONE_DB_PATH ?? "data/sseclone.db",
  },
});
