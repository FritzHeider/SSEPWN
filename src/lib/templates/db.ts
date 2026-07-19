/**
 * Template persistence (Phase 09). Maps between the `templates` table rows and
 * the pure {@link Template} model, and offers the small set of queries the API /
 * gallery need. Kept thin: all validation lives in `./types`, all application
 * logic in `./apply`; this module only moves rows in and out and re-parses the
 * JSON columns through the boundary validators so a hand-corrupted row can never
 * reach `applyTemplate`.
 */

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { templates } from "../db/schema";
import * as schema from "../db/schema";
import {
  parseTemplateCta,
  parseTemplateInput,
  type Template,
  type TemplateCta,
  type TemplateInput,
} from "./types";
import {
  CAPTION_PRESET_NAMES,
  DEFAULT_CAPTION_PRESET,
  resolveStyle,
  type CaptionPreset,
} from "../captions/style";
import { ASPECT_RATIOS, type AspectRatio } from "../crop/types";

/** A drizzle db bound to this app's schema (same shape the routes use). */
export type TemplatesDb = BetterSQLite3Database<typeof schema>;

/** The raw shape a `templates` row select returns. */
type TemplateRow = typeof templates.$inferSelect;

function safeParseArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeParseObject(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function asCaptionPreset(value: string): CaptionPreset {
  return (CAPTION_PRESET_NAMES as readonly string[]).includes(value)
    ? (value as CaptionPreset)
    : DEFAULT_CAPTION_PRESET;
}

function asAspectRatio(value: string): AspectRatio {
  return (ASPECT_RATIOS as readonly string[]).includes(value)
    ? (value as AspectRatio)
    : "9:16";
}

/** Turn a stored row into a validated {@link Template}. Malformed JSON columns
 * fall back to safe values rather than throwing far from the corruption. */
export function rowToTemplate(row: TemplateRow): Template {
  const ctas: TemplateCta[] = safeParseArray(row.ctas)
    .map(parseTemplateCta)
    .filter((c): c is TemplateCta => c !== null);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    builtin: row.builtin,
    captionPreset: asCaptionPreset(row.captionPreset),
    captionStyle: resolveStyle(safeParseObject(row.captionStyle)),
    aspectRatio: asAspectRatio(row.aspectRatio),
    ctas,
    brandPrimary: row.brandPrimary,
    brandSecondary: row.brandSecondary,
    watermarkAssetId: row.watermarkAssetId,
  };
}

/** Column values for inserting a {@link TemplateInput}. `builtin` defaults to
 * false; pass `true` for the shipped templates. */
export function templateInsertValues(
  input: TemplateInput,
  builtin = false,
): typeof templates.$inferInsert {
  return {
    key: input.key,
    name: input.name,
    builtin,
    captionPreset: input.captionPreset,
    captionStyle: JSON.stringify(input.captionStyle),
    aspectRatio: input.aspectRatio,
    ctas: JSON.stringify(input.ctas),
    brandPrimary: input.brandPrimary,
    brandSecondary: input.brandSecondary,
    watermarkAssetId: input.watermarkAssetId,
  };
}

/** All templates, built-ins first then saved, each newest-last within a group. */
export function listTemplates(db: TemplatesDb): Template[] {
  return db
    .select()
    .from(templates)
    .all()
    .map(rowToTemplate)
    .sort((a, b) => (a.builtin === b.builtin ? a.id - b.id : a.builtin ? -1 : 1));
}

/** One template by id, or `null` when it does not exist. */
export function getTemplate(db: TemplatesDb, id: number): Template | null {
  const row = db.select().from(templates).where(eq(templates.id, id)).get();
  return row ? rowToTemplate(row) : null;
}

/** Insert a user-saved template from an untrusted input, returning the row.
 * Runs through {@link parseTemplateInput} so the stored row is always clean. */
export function insertTemplate(db: TemplatesDb, input: unknown): Template {
  const clean = parseTemplateInput(input);
  // A saved template never claims a built-in slug.
  const values = templateInsertValues({ ...clean, key: null }, false);
  const [row] = db.insert(templates).values(values).returning().all();
  return rowToTemplate(row);
}

/** Rename a saved template. Built-ins are protected by the caller (the route);
 * this only writes the name. Returns the updated template or `null` if absent. */
export function renameTemplate(db: TemplatesDb, id: number, name: string): Template | null {
  db.update(templates).set({ name: name.trim() || "Untitled template" }).where(eq(templates.id, id)).run();
  return getTemplate(db, id);
}

/** Delete a saved template by id. Returns true when a row was removed. Callers
 * must refuse to delete built-ins (they are undeletable per SPEC). */
export function deleteTemplate(db: TemplatesDb, id: number): boolean {
  const res = db.delete(templates).where(eq(templates.id, id)).run();
  return res.changes > 0;
}
