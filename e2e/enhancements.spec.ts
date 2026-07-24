import { expect, test } from "@playwright/test";

import { SEEDED_BROLL_ASSET_ID, SEEDED_ENHANCE_CLIP_ID } from "./seed";

/**
 * Phase-08 acceptance e2e: on a seeded clip, place a B-roll slot (from the asset
 * library) and a CTA overlay (a built-in text preset), then confirm BOTH persist
 * across a full page reload AND render in the live preview DOM.
 *
 * Everything runs in a real browser against the real Next server and a real
 * SQLite DB — nothing mocked. Persistence is asserted two ways: directly against
 * the GET timeline API (the server truly stored both overlay entries) and, per
 * the acceptance criterion, by reloading and reading the rendered editor.
 *
 * Both overlays are placed at the playhead, which sits at 0 on a fresh load, so
 * the preview overlays (active-at-playhead) are visible without any seeking. We
 * additionally widen each range to 3 s through its editor field so the visible
 * window is comfortably wide and the assertion never races a stray timeupdate.
 */
const CLIP_URL = `/clips/${SEEDED_ENHANCE_CLIP_ID}`;
const TIMELINE_API = `/api/clips/${SEEDED_ENHANCE_CLIP_ID}/timeline`;

interface OverlayEntry {
  kind: string;
}

/** Poll the GET timeline API until the overlay track holds one B-roll and one CTA. */
async function overlayKinds(request: import("@playwright/test").APIRequestContext): Promise<string[]> {
  const res = await request.get(TIMELINE_API);
  if (!res.ok()) return [];
  const body = (await res.json()) as { timeline: { overlayTrack: OverlayEntry[] } };
  return body.timeline.overlayTrack.map((o) => o.kind);
}

test("place a B-roll slot and a CTA, both persist across reload and render in preview", async ({ page, request }) => {
  await page.goto(CLIP_URL);

  const timeline = page.getByRole("region", { name: "Timeline editor" });
  await expect(timeline.getByTestId("timeline-segment")).toHaveCount(1);
  // Wait for the shared `<video>` to load metadata so the preview frame has a
  // real height — the overlays are `absolute inset-0`, so an unsized frame would
  // give them a zero box and defeat the visibility checks below.
  const video = timeline.locator("video").first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);

  // The two-pane editor hosts the B-roll / CTA / SFX editors on the Timeline tab
  // of the right pane; switch to it before driving those panels. The shared player
  // and its overlays live in the always-visible left pane.
  await timeline.getByTestId("editor-tab-timeline").click();

  // --- place a B-roll slot from the asset library ---------------------------
  const broll = timeline.getByRole("region", { name: "B-roll" });
  await broll.getByRole("button", { name: "Add at playhead" }).click();
  const picker = broll.getByTestId("asset-picker");
  await expect(picker).toHaveAttribute("data-kind", "video");
  // The seeded, pre-probed video asset is listed; pick it by its known id (the
  // attribute lives on the option button itself).
  await picker.locator(`[data-testid="asset-option"][data-asset-id="${SEEDED_BROLL_ASSET_ID}"]`).click();

  const brollRow = broll.getByTestId("broll-row");
  await expect(brollRow).toHaveCount(1);
  // Widen the slot to 0–3 s so its preview window is comfortably around playhead 0.
  await brollRow.getByLabel("out").fill("3");

  // --- place a CTA overlay from a built-in preset ---------------------------
  const cta = timeline.getByRole("region", { name: "CTA overlays" });
  await cta.getByRole("button", { name: "Follow for more" }).click();
  const ctaRow = cta.getByTestId("cta-row");
  await expect(ctaRow).toHaveCount(1);
  await expect(ctaRow).toHaveAttribute("data-cta-variant", "text");
  await ctaRow.getByLabel("to").fill("3");

  // --- both render in the live preview DOM at the playhead ------------------
  await expect(timeline.getByTestId("broll-overlay")).toBeVisible();
  await expect(timeline.getByTestId("broll-preview")).toHaveCount(1);
  await expect(timeline.getByTestId("cta-overlay")).toBeVisible();
  await expect(timeline.getByTestId("cta-preview")).toHaveCount(1);

  // --- server durably stored both overlay entries ---------------------------
  await expect
    .poll(() => overlayKinds(request), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(["broll", "cta"]));

  // --- acceptance criterion: reload → both persist and re-render -------------
  await page.reload();
  // The reload resets to the default tab; re-open the Timeline tab to read the rows.
  await timeline.getByTestId("editor-tab-timeline").click();
  await expect(timeline.getByTestId("broll-row")).toHaveCount(1);
  await expect(timeline.getByTestId("cta-row")).toHaveCount(1);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await expect(timeline.getByTestId("broll-overlay")).toBeVisible();
  await expect(timeline.getByTestId("cta-overlay")).toBeVisible();
});
