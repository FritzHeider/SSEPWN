/**
 * The three shipped templates and their idempotent seeding (SPEC.md § Feature
 * checklist 11 "≥3 built-in templates: TikTok bold, Shorts clean, Reels
 * minimal", Phase 09).
 *
 * Each built-in is defined as a raw bundle run through `parseTemplateInput`, so
 * it is a complete, validated {@link TemplateInput} with the
 * `highlightColor === brandPrimary` invariant already enforced. Seeding keys on
 * the unique `key` slug and uses INSERT … ON CONFLICT DO NOTHING, so running the
 * seed (or the migrate that calls it) any number of times leaves exactly three
 * built-ins — the Phase-09 idempotency requirement.
 */

import { templates } from "../db/schema";
import { templateInsertValues, type TemplatesDb } from "./db";
import { parseTemplateInput, type TemplateInput } from "./types";

/** Stable slugs for the three built-ins (also their `key` column values). */
export const BUILTIN_TEMPLATE_KEYS = ["tiktok-bold", "shorts-clean", "reels-minimal"] as const;
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATE_KEYS)[number];

/**
 * The three built-in bundles, in gallery order. Defined via `parseTemplateInput`
 * so any typo (bad color, unknown preset) is normalised to a safe default rather
 * than shipping a broken template.
 */
export const BUILTIN_TEMPLATES: readonly TemplateInput[] = [
  parseTemplateInput({
    key: "tiktok-bold",
    name: "TikTok Bold",
    captionPreset: "bold-pop",
    aspectRatio: "9:16",
    brandPrimary: "#FFE600", // punchy yellow karaoke highlight
    brandSecondary: "#111111",
    ctas: [
      {
        variant: "text",
        content: "Follow for more",
        position: "bottom-center",
        start: 0,
        end: 9999, // clamps to the clip's real length at apply time
        animIn: "slide",
        animOut: "fade",
        fontSize: 0.07,
      },
    ],
  }),
  parseTemplateInput({
    key: "shorts-clean",
    name: "Shorts Clean",
    captionPreset: "clean-sub",
    aspectRatio: "9:16",
    brandPrimary: "#FFFFFF",
    brandSecondary: "#1D9BF0", // clean blue accent
    ctas: [],
  }),
  parseTemplateInput({
    key: "reels-minimal",
    name: "Reels Minimal",
    captionPreset: "minimal-caps",
    aspectRatio: "9:16",
    brandPrimary: "#FFFFFF",
    brandSecondary: "#E1306C", // instagram magenta accent
    ctas: [],
  }),
];

/**
 * Insert the three built-in templates, idempotently. Keyed on the unique `key`
 * slug with ON CONFLICT DO NOTHING, so a second run inserts nothing and the
 * table still holds exactly three built-ins. Returns how many rows were actually
 * inserted (3 on a fresh DB, 0 thereafter).
 */
export function seedBuiltinTemplates(db: TemplatesDb): number {
  let inserted = 0;
  for (const input of BUILTIN_TEMPLATES) {
    const res = db
      .insert(templates)
      .values(templateInsertValues(input, true))
      .onConflictDoNothing({ target: templates.key })
      .run();
    inserted += res.changes;
  }
  return inserted;
}
