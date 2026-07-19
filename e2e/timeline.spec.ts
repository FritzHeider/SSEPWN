import { expect, test } from "@playwright/test";

import { SEEDED_CLIP_ID } from "./seed";

/**
 * Phase-07 acceptance e2e: open the editor on a seeded clip, split at the
 * playhead, delete the second segment, and confirm the edit persists across a
 * full page reload (the debounced `PATCH /api/clips/:id/timeline` write-behind).
 *
 * The whole flow runs in a real browser against the real Next server and a real
 * SQLite DB — nothing here is mocked. Persistence is asserted two ways: directly
 * against the GET API (the server truly stored one segment) and, per the
 * acceptance criterion, by reloading the page and reading the rendered strip.
 */
const CLIP_URL = `/clips/${SEEDED_CLIP_ID}`;
const TIMELINE_API = `/api/clips/${SEEDED_CLIP_ID}/timeline`;

test("split at playhead, delete the second segment, persists across reload", async ({ page, request }) => {
  await page.goto(CLIP_URL);

  const timeline = page.getByRole("region", { name: "Timeline editor" });
  const video = timeline.locator("video");
  const segments = timeline.getByTestId("timeline-segment");
  // A fresh clip is one segment spanning the whole source window.
  await expect(segments).toHaveCount(1);

  // Seek into the interior, then split there — producing two contiguous
  // segments. The ruler stretches past `total * pxPerSec` (its min-width fills
  // the container), so we click an explicit x: at 60px/s, x=180 maps to 3s,
  // the midpoint of the seeded 0–6s clip.
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await timeline.getByLabel("Seek bar").click({ position: { x: 180, y: 12 } });
  // Wait for the seek to land (the single <video> drives the playhead) so the
  // split happens at the interior playhead, not at the pre-seek origin.
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(2);

  await timeline.getByRole("button", { name: "Split (S)" }).click();
  await expect(segments).toHaveCount(2);

  // The split keeps the left id (`seg-1`) and mints `seg-2` on the right.
  await expect(segments.nth(0)).toHaveAttribute("data-segment-id", "seg-1");
  await expect(segments.nth(1)).toHaveAttribute("data-segment-id", "seg-2");

  // Select the SECOND segment, then delete it.
  await segments.nth(1).click();
  await timeline.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(segments).toHaveCount(1);
  await expect(segments.nth(0)).toHaveAttribute("data-segment-id", "seg-1");

  // The optimistic write-behind is debounced; poll the API until the server has
  // durably stored the one-segment result before reloading.
  await expect
    .poll(
      async () => {
        const res = await request.get(TIMELINE_API);
        if (!res.ok()) return -1;
        const body = (await res.json()) as { timeline: { segments: unknown[] } };
        return body.timeline.segments.length;
      },
      { timeout: 10_000 },
    )
    .toBe(1);

  // Acceptance criterion: reload → the strip shows the persisted result.
  await page.reload();
  await expect(segments).toHaveCount(1);
  await expect(segments.nth(0)).toHaveAttribute("data-segment-id", "seg-1");
});
