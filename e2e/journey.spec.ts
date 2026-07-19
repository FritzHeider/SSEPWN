import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * Phase-11 acceptance: the full user journey, end to end, in a real browser
 * against the real Next server and a real SQLite DB — nothing mocked.
 *
 *   upload a fixture → wait for the pipeline (ingest → transcribe → generate-clips)
 *   → open the top clip → edit a caption word → switch to 9:16 → apply the
 *   tiktok-bold template → split the timeline and delete a segment → export a
 *   draft tiktok clip → the download is a valid MP4.
 *
 * The Next server only enqueues jobs; the long-running media work runs in the
 * pipeline worker (global constraint). The e2e webServer (`e2e/server.ts`) serves
 * the production build AND runs that worker loop in the same process, so uploads,
 * the ingest → transcribe → generate-clips chain, and the export render all share
 * one DB connection and stay visible to the UI. `TRANSCRIBER=fake` (webServer env)
 * replays `tests/samples/transcripts/long-sample.json` off the uploaded filename,
 * so captions exist to edit without ever calling real whisper.
 */
const FIXTURE = fileURLToPath(new URL("../fixtures/long-sample.mp4", import.meta.url));

test("full journey: upload → pipeline → caption edit → 9:16 → tiktok-bold → split/delete → export draft → valid mp4", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  // --- 1. Upload a fixture from the dashboard; read the created project id -----
  await page.goto("/");
  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/projects") && r.request().method() === "POST",
    ),
    page.locator('input[type="file"]').setInputFiles(FIXTURE),
  ]);
  expect(uploadResponse.status()).toBe(201);
  const { project } = (await uploadResponse.json()) as { project: { id: number } };
  const projectId = project.id;

  // --- 2. Wait for the worker to drain the whole pipeline ----------------------
  // The best-scored clip only exists once generate-clips (the last link) has run,
  // so polling the clips API until it is non-empty proves the chain completed.
  let topClip: { id: number; inPoint: number; outPoint: number } | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/projects/${projectId}/clips`);
        if (!res.ok()) return 0;
        const body = (await res.json()) as {
          clips: Array<{ id: number; inPoint: number; outPoint: number }>;
        };
        topClip = body.clips[0];
        return body.clips.length;
      },
      { timeout: 180_000, intervals: [2000] },
    )
    .toBeGreaterThan(0);
  if (!topClip) throw new Error("no clip was generated");
  const clipDuration = topClip.outPoint - topClip.inPoint;

  // --- 3. Open the top clip editor ---------------------------------------------
  await page.goto(`/clips/${topClip.id}`);

  // --- 3a. Edit a caption word (words come from the fake transcript) -----------
  const captions = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Captions", level: 2 }) });
  const firstWord = page.getByTestId("caption-word").first();
  await expect(firstWord).toBeVisible();
  await firstWord.click();
  const wordInput = captions.getByRole("textbox");
  await expect(wordInput).toBeVisible();
  await wordInput.fill("sseclone");
  await wordInput.press("Enter");
  // The committed edit replaces the whole caption doc in place; the word button
  // now reads the new (raw) text.
  await expect(page.getByTestId("caption-word").filter({ hasText: "sseclone" })).toHaveCount(1);

  // --- 3b. Switch the crop to 9:16, then drag a reframe keyframe ---------------
  const aspect = page.getByRole("group", { name: "Aspect ratio" });
  const vertical = aspect.getByRole("button", { name: "9:16" });
  await vertical.click();
  await expect(vertical).toHaveAttribute("aria-pressed", "true");

  // Drag the crop window to write a manual keyframe. This is what lets the export
  // render a 9:16 crop without the opt-in Human face models (auto smart-crop needs
  // them; a manual keyframe does not) — and every clip that carries a 9:16 crop
  // needs at least one keyframe for the render's cropFilter.
  const cropSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Crop" }) });
  const cropVideo = cropSection.locator("video").first();
  await expect
    .poll(() => cropVideo.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(0);
  const cropBox = page.getByLabel("9:16 crop window — drag to reposition");
  await expect(cropBox).toBeVisible();
  const box = await cropBox.boundingBox();
  if (!box) throw new Error("crop window has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  // The drag persisted a keyframe (PATCH /api/clips/:id/crop) → the crop becomes
  // "locked". Wait for that durable signal before moving on.
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/clips/${topClip!.id}/crop`);
        if (!res.ok()) return false;
        const body = (await res.json()) as { crop: { aspectRatio: string; keyframes: unknown[] } | null };
        return !!body.crop && body.crop.aspectRatio === "9:16" && body.crop.keyframes.length > 0;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // --- 3c. Apply the built-in tiktok-bold template -----------------------------
  const card = page.getByTestId("template-card").filter({ hasText: "TikTok Bold" });
  await expect(card).toHaveCount(1);
  await card.getByTestId("apply-template").click();
  // The POST persisted and the server component refreshed: the card flips applied.
  await expect(card).toHaveAttribute("data-applied", "true");

  // --- 3d. Split the timeline at the midpoint, delete the second segment -------
  const timeline = page.getByRole("region", { name: "Timeline editor" });
  const segments = timeline.getByTestId("timeline-segment");
  const video = timeline.locator("video").first();
  await expect(segments).toHaveCount(1);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(0);

  // The ruler renders at 60 px/s (DEFAULT_PX_PER_SEC), so x = (duration/2)*60
  // lands the playhead on the clip's midpoint — safely interior for a split.
  await timeline.getByLabel("Seek bar").click({ position: { x: (clipDuration / 2) * 60, y: 12 } });
  await timeline.getByRole("button", { name: "Split (S)" }).click();
  await expect(segments).toHaveCount(2);

  await segments.nth(1).click();
  await timeline.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(segments).toHaveCount(1);

  // The debounced write-behind persisted the one-segment result server-side.
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/clips/${topClip!.id}/timeline`);
        if (!res.ok()) return -1;
        const body = (await res.json()) as { timeline: { segments: unknown[] } };
        return body.timeline.segments.length;
      },
      { timeout: 10_000 },
    )
    .toBe(1);

  // --- 3e. Export a draft tiktok clip; the worker renders it -------------------
  const exportPanel = page.getByRole("region", { name: "Export" });
  await exportPanel.getByTestId("export-preset").selectOption("tiktok");
  await exportPanel.getByTestId("export-quality").selectOption("draft");
  await exportPanel.getByTestId("export-start").click();

  const exportRow = page.getByTestId("export-row").first();
  await expect(exportRow).toBeVisible();
  await expect(exportRow).toHaveAttribute("data-status", "done", { timeout: 180_000 });
  const exportId = await exportRow.getAttribute("data-export-id");
  expect(exportId).toBeTruthy();

  // --- 4. The download is a valid MP4 ------------------------------------------
  const download = await request.get(`/api/exports/${exportId}/download`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toBe("video/mp4");
  const bytes = await download.body();
  // A real MP4 opens with a box-size word then the "ftyp" box type at bytes 4–8.
  expect(bytes.byteLength).toBeGreaterThan(1000);
  expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
});
