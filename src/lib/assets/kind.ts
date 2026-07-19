/**
 * Accepted asset types for the Phase 08 asset library (SPEC.md § Feature
 * checklist 7–10): video for B-roll, audio for sound effects, and images for
 * logos / CTA graphics.
 *
 * Like `upload/allowed.ts` for source videos, the declared MIME type and the
 * filename extension must AGREE — a client that sends either one alone is not
 * trusted. This module is deliberately dependency-free so the browser asset
 * picker can pre-filter against the exact rules the server enforces; the
 * `/api/assets` route (via `receiveUpload`) is the enforcing authority.
 */

export type AssetKind = "video" | "audio" | "image";

interface AssetTypeEntry {
  kind: AssetKind;
  exts: readonly string[];
}

export const ALLOWED_ASSET_TYPES: Readonly<Record<string, AssetTypeEntry>> = {
  "video/mp4": { kind: "video", exts: [".mp4"] },
  "video/quicktime": { kind: "video", exts: [".mov"] },
  "video/webm": { kind: "video", exts: [".webm"] },
  "audio/mpeg": { kind: "audio", exts: [".mp3"] },
  "audio/wav": { kind: "audio", exts: [".wav"] },
  "audio/x-wav": { kind: "audio", exts: [".wav"] },
  "audio/aac": { kind: "audio", exts: [".aac", ".m4a"] },
  "audio/mp4": { kind: "audio", exts: [".m4a"] },
  "audio/ogg": { kind: "audio", exts: [".ogg"] },
  "image/png": { kind: "image", exts: [".png"] },
  "image/jpeg": { kind: "image", exts: [".jpg", ".jpeg"] },
  "image/webp": { kind: "image", exts: [".webp"] },
};

/** Every valid `AssetKind`, for validating a `?kind=` query filter. */
export const ASSET_KINDS: readonly AssetKind[] = ["video", "audio", "image"];

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * The media class of an upload, or null when the MIME type is not accepted OR
 * its extension disagrees with the type. Both must line up — the same rule the
 * source-video boundary uses — so a renamed file cannot smuggle in a type the
 * probe/preview code can't handle.
 */
export function assetKind(mime: string, ext: string): AssetKind | null {
  const entry = ALLOWED_ASSET_TYPES[(mime ?? "").toLowerCase()];
  if (!entry) return null;
  return entry.exts.includes((ext ?? "").toLowerCase()) ? entry.kind : null;
}

/**
 * The MIME → extensions map `receiveUpload` expects for its `allowedTypes`
 * option, derived from the single source of truth above so the two never drift.
 */
export function assetAllowedTypesMap(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(ALLOWED_ASSET_TYPES).map(([mime, { exts }]) => [mime, exts]),
  );
}

/** Every accepted asset extension, de-duplicated — for prose and `accept`. */
export function allowedAssetExtensions(): string[] {
  const seen = new Set<string>();
  for (const { exts } of Object.values(ALLOWED_ASSET_TYPES)) {
    for (const ext of exts) seen.add(ext);
  }
  return [...seen];
}

/**
 * Client-side pre-filter mirroring the server rule: the MIME type must be
 * known AND the extension must be one that type permits. Never a security
 * boundary — the route re-checks every upload.
 */
export function isAcceptedAssetFile(file: { name: string; type: string }): boolean {
  return assetKind(file.type ?? "", fileExtension(file.name ?? "")) !== null;
}

/**
 * Lowercased final extension, or "" when there is none. Hand-rolled (not
 * `node:path`) so this module stays importable from a client component; a
 * leading dot is a dotfile, not an extension.
 */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
