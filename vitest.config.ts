import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the "@/*" -> "./src/*" paths mapping in tsconfig.json so tests can
  // import route handlers, which use the alias.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Several integration tests shell out to ffmpeg (scene detection decodes
    // every frame, ~5 s on the fixture) and run in parallel, so they compete
    // for CPU. The 5 s default races that real work; 30 s is slack for the
    // media subprocesses without hiding a genuine hang. Unit tests finish in
    // milliseconds regardless.
    testTimeout: 30_000,
  },
});
