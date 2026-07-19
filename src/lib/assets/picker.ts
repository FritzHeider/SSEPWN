/**
 * Pure presentation logic for the Phase 08 asset picker (browse / upload /
 * select by kind).
 *
 * React- and Node-free by design (DEC-005): every decision the picker makes —
 * how an asset is labelled, which files a kind accepts, whether an upload is
 * plausible before it leaves the browser — lives here where it can be
 * unit-tested, and the thin `<AssetPicker>` component only wires these to the
 * network and the DOM. Importing this from a client component is safe: its only
 * dependencies are the dependency-free `kind` module and the equally pure
 * `projects/view` formatters.
 */

import { EMPTY, formatDuration, formatResolution } from "@/lib/projects/view";

import { ALLOWED_ASSET_TYPES, assetKind, fileExtension, isAssetKind, type AssetKind } from "./kind";

/**
 * The serialisable subset of an `assets` row the picker renders. Mirrors what
 * `GET /api/assets` returns (a full row) but names only the fields the UI uses,
 * so this stays importable from a client component — the drizzle row type pulls
 * in the db, this does not.
 */
export interface PickerAsset {
  id: number;
  kind: AssetKind | null;
  type: string;
  mime: string | null;
  originalName: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  thumbnailPath: string | null;
}

/** Title-cased kind for headings and prose ("Video" / "Audio" / "Image"). */
export function kindLabel(kind: AssetKind): string {
  return kind[0].toUpperCase() + kind.slice(1);
}

/** Human label — the uploaded filename, else a stable `<Kind> #<id>` fallback. */
export function assetLabel(asset: Pick<PickerAsset, "id" | "kind" | "originalName">): string {
  const name = asset.originalName?.trim();
  if (name) return name;
  return `${asset.kind ? kindLabel(asset.kind) : "Asset"} #${asset.id}`;
}

/**
 * Secondary line: resolution for image/video, duration for audio/video, joined
 * by " · ". Empty while the asset is still un-probed (both formatters return
 * EMPTY), so the caller can omit the line rather than render a lone dash.
 */
export function assetMeta(asset: Pick<PickerAsset, "width" | "height" | "duration">): string {
  const parts: string[] = [];
  const res = formatResolution(asset.width, asset.height);
  if (res !== EMPTY) parts.push(res);
  const dur = formatDuration(asset.duration);
  if (dur !== EMPTY) parts.push(dur);
  return parts.join(" · ");
}

/** Whether the browse grid can show a poster for this asset. */
export function hasThumbnail(asset: Pick<PickerAsset, "thumbnailPath">): boolean {
  return Boolean(asset.thumbnailPath);
}

/**
 * Poster URL for an asset, or null when it has none — audio never gets one, and
 * video/image assets have none until the asset-probe worker fills it in. Ids
 * come from the DB, never from user input, so there is no traversal surface.
 */
export function assetThumbnailUrl(asset: Pick<PickerAsset, "id" | "thumbnailPath">): string | null {
  return asset.thumbnailPath ? `/api/assets/${asset.id}/thumbnail` : null;
}

/** GET URL for the whole library of one kind — assets are shared, not per-clip. */
export function assetsListUrl(kind: AssetKind): string {
  return `/api/assets?kind=${encodeURIComponent(kind)}`;
}

/** Every extension one kind accepts, de-duplicated, for prose ("mp4, mov, …"). */
export function acceptedExtensions(kind: AssetKind): string[] {
  const exts: string[] = [];
  for (const entry of Object.values(ALLOWED_ASSET_TYPES)) {
    if (entry.kind === kind) exts.push(...entry.exts);
  }
  return unique(exts);
}

/**
 * The `accept` attribute for a file input scoped to one kind: MIME types AND
 * extensions, because browsers match them inconsistently (mirrors the source
 * video picker's `fileInputAccept`).
 */
export function assetInputAccept(kind: AssetKind): string {
  const parts: string[] = [];
  for (const [mime, entry] of Object.entries(ALLOWED_ASSET_TYPES)) {
    if (entry.kind !== kind) continue;
    parts.push(mime, ...entry.exts);
  }
  return unique(parts).join(",");
}

/**
 * Fast client-side check that a picked file is acceptable AND of the expected
 * kind. Returns null when fine, else a user-facing message. Never a security
 * boundary — `POST /api/assets` re-checks every upload on the server, where the
 * client cannot lie about the type.
 */
export function validatePickedFile(
  file: { name: string; type: string },
  kind: AssetKind,
): string | null {
  const detected = assetKind(file.type ?? "", fileExtension(file.name ?? ""));
  if (detected === null) {
    return `"${file.name}" is not a supported ${kind} file. Allowed: ${acceptedExtensions(kind).join(", ")}`;
  }
  if (detected !== kind) {
    return `"${file.name}" is a ${detected} file, but a ${kind} asset is expected here.`;
  }
  return null;
}

/**
 * Whether the browse list should keep polling for probe results: true while any
 * visual asset (video/image) is still missing its poster. Audio never gets one,
 * so it never keeps the poll alive.
 */
export function hasUnprobedThumbnails(assets: readonly PickerAsset[]): boolean {
  return assets.some((a) => (a.kind === "video" || a.kind === "image") && !a.thumbnailPath);
}

/**
 * Narrow an untyped `GET /api/assets` body to the picker's view of it, dropping
 * any entry without a numeric id. The network is a system boundary even when
 * it's our own route, so nothing downstream trusts the shape blindly.
 */
export function parseAssetsResponse(body: unknown): PickerAsset[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { assets?: unknown }).assets;
  if (!Array.isArray(list)) return [];
  const out: PickerAsset[] = [];
  for (const raw of list) {
    const asset = toPickerAsset(raw);
    if (asset) out.push(asset);
  }
  return out;
}

function toPickerAsset(raw: unknown): PickerAsset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || !Number.isInteger(r.id)) return null;
  return {
    id: r.id,
    kind: isAssetKind(r.kind) ? r.kind : null,
    type: typeof r.type === "string" ? r.type : "",
    mime: typeof r.mime === "string" ? r.mime : null,
    originalName: typeof r.originalName === "string" ? r.originalName : null,
    width: numOrNull(r.width),
    height: numOrNull(r.height),
    duration: numOrNull(r.duration),
    thumbnailPath: typeof r.thumbnailPath === "string" ? r.thumbnailPath : null,
  };
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
