import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";

import type { AssetKind } from "./kind";

export interface NewAsset {
  /** Optional owning project; B-roll/SFX/CTA assets can be library-global. */
  projectId?: number | null;
  /** Semantic role (source | broll | sfx | logo | cta). */
  type: string;
  kind: AssetKind;
  mime: string;
  path: string;
  originalName?: string | null;
}

export type AssetRow = typeof assets.$inferSelect;

/** Persist a freshly uploaded asset; probed metadata is filled in later. */
export function insertAsset(asset: NewAsset): AssetRow {
  const [row] = db
    .insert(assets)
    .values({
      projectId: asset.projectId ?? null,
      type: asset.type,
      kind: asset.kind,
      mime: asset.mime,
      path: asset.path,
      originalName: asset.originalName ?? null,
    })
    .returning()
    .all();
  return row;
}

export interface ListAssetsFilter {
  kind?: AssetKind;
  projectId?: number;
}

/** Newest first; filterable by kind and/or owning project. */
export function listAssets(filter: ListAssetsFilter = {}): AssetRow[] {
  const conditions = [];
  if (filter.kind) conditions.push(eq(assets.kind, filter.kind));
  if (filter.projectId !== undefined) conditions.push(eq(assets.projectId, filter.projectId));
  const where = conditions.length === 1 ? conditions[0] : conditions.length ? and(...conditions) : undefined;
  return db
    .select()
    .from(assets)
    .where(where)
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .all();
}

export function getAsset(id: number): AssetRow | undefined {
  return db.select().from(assets).where(eq(assets.id, id)).get();
}
