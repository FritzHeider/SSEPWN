import { expect, test } from "@playwright/test";

import { SEEDED_TEMPLATE_CLIP_ID, TIKTOK_BOLD_NAME } from "./seed";

/**
 * Phase-09 acceptance e2e: apply the built-in `tiktok-bold` template to a seeded
 * clip and confirm the two things the phase's acceptance criterion names — the
 * caption preview's class/style changes, and the template's CTA appears.
 *
 * The seed pre-loads clip 3 with a `clean-sub` caption look (white highlight,
 * lowercase, no karaoke) over one spoken line, plus a single-segment timeline.
 * Applying `tiktok-bold` must therefore VISIBLY rewrite the caption look to
 * `bold-pop` (yellow highlight, uppercase) and drop its "Follow for more" CTA
 * onto the overlay track. Everything runs in a real browser against the real
 * Next server and a real SQLite DB — nothing mocked.
 *
 * Applying persists server-side and refreshes the server component (so the
 * gallery card flips to "applied"), but the caption editor and timeline panel
 * hold their document in local state seeded from props, so the live previews
 * only pick up the new look after a reload — which is exactly the persistence
 * the acceptance cares about, so the spec reloads and asserts against the
 * durably-stored state.
 */
const CLIP_URL = `/clips/${SEEDED_TEMPLATE_CLIP_ID}`;

test("apply tiktok-bold: caption preview restyles to bold-pop and the CTA appears", async ({ page }) => {
  await page.goto(CLIP_URL);

  const timeline = page.getByRole("region", { name: "Timeline editor" });
  const boldPop = page.getByRole("button", { name: "Bold pop" });
  const highlight = page.getByLabel("Highlight", { exact: true });
  const captionOverlay = page.getByTestId("caption-overlay");

  // --- baseline: the seeded clip is on the clean-sub look ---------------------
  await expect(page.getByRole("button", { name: "Clean sub" })).toHaveAttribute("aria-pressed", "true");
  await expect(boldPop).toHaveAttribute("aria-pressed", "false");
  await expect(highlight).toHaveValue(/^#ffffff$/i);
  // The live caption overlay renders the active cue at the playhead (0 s), in the
  // clean-sub look: lowercase, no CTA on the overlay track yet.
  await expect(captionOverlay).toContainText("hello");
  await expect(timeline.getByTestId("cta-row")).toHaveCount(0);
  await expect(timeline.getByTestId("cta-overlay")).toHaveCount(0);

  // --- apply the built-in tiktok-bold template from the gallery ---------------
  const card = page.getByTestId("template-card").filter({ hasText: TIKTOK_BOLD_NAME });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-applied", "false");
  await card.getByTestId("apply-template").click();
  // The server persisted the application and the page refreshed: the card flips
  // to "applied". This is the durable signal that the POST landed before reload.
  await expect(card).toHaveAttribute("data-applied", "true");

  // --- reload → the persisted bold-pop look drives both live previews ---------
  await page.reload();

  // Caption preview class/style changed: bold-pop is now the active preset, the
  // highlight colour is the template's brand yellow, and the overlay text is
  // uppercased (a bold-pop style property the clean-sub look did not have).
  await expect(boldPop).toHaveAttribute("aria-pressed", "true");
  await expect(highlight).toHaveValue(/^#ffe600$/i);
  await expect(captionOverlay).toContainText("HELLO");

  // CTA appeared: the template's "Follow for more" text CTA is on the overlay
  // track and rendered in the live preview at the playhead.
  const ctaRow = timeline.getByTestId("cta-row");
  await expect(ctaRow).toHaveCount(1);
  await expect(ctaRow).toHaveAttribute("data-cta-variant", "text");
  await expect(ctaRow.getByLabel("CTA text")).toHaveValue("Follow for more");

  // The overlay renders over the source frame; wait for the <video> to size the
  // frame so the `absolute inset-0` overlay has a real box before asserting it.
  const video = timeline.locator("video").first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await expect(timeline.getByTestId("cta-overlay")).toBeVisible();
  await expect(timeline.getByTestId("cta-preview")).toContainText("Follow for more");
});
