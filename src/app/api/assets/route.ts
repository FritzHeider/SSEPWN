import { unlink } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { assetAllowedTypesMap, assetKind, fileExtension, isAssetKind } from "@/lib/assets/kind";
import { insertAsset, listAssets } from "@/lib/assets/queries";
import { receiveUpload, UploadError } from "@/lib/upload/receive";

// busboy + node:fs streaming and the db singleton both need Node APIs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where asset uploads land; overridable so tests never touch the real dir. */
function assetUploadDir(): string {
  return process.env.SSECLONE_ASSET_DIR ?? path.join("data", "assets");
}

/**
 * GET /api/assets — the asset library, newest first. Filter with `?kind=`
 * (video|audio|image) and/or `?projectId=`. An unknown kind is a 400 rather
 * than a silently-empty list, so a typo in the picker surfaces immediately.
 */
export function GET(request: Request) {
  const url = new URL(request.url);

  const kindParam = url.searchParams.get("kind");
  if (kindParam !== null && !isAssetKind(kindParam)) {
    return NextResponse.json({ error: `Unknown asset kind "${kindParam}"`, code: "bad_kind" }, { status: 400 });
  }

  const projectParam = url.searchParams.get("projectId");
  const projectId = projectParam !== null ? Number(projectParam) : undefined;
  if (projectParam !== null && !Number.isInteger(projectId)) {
    return NextResponse.json({ error: "projectId must be an integer", code: "bad_project" }, { status: 400 });
  }

  return NextResponse.json({ assets: listAssets({ kind: kindParam ?? undefined, projectId }) });
}

/**
 * POST /api/assets — accept a B-roll / SFX / logo upload and register it.
 *
 * Like the project upload, the handler streams bytes to disk and does no media
 * work (global constraint — probing and thumbnailing are the asset-probe worker
 * job's responsibility). `receiveUpload` already enforced the type against the
 * asset allow-list; we re-derive `kind` from the same MIME + extension to store
 * it, and clean up the file if registration fails.
 */
export async function POST(request: Request) {
  let upload;
  try {
    upload = await receiveUpload(request, {
      uploadDir: assetUploadDir(),
      allowedTypes: assetAllowedTypesMap(),
    });
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }

  const kind = assetKind(upload.mimeType, fileExtension(upload.originalName));
  if (!kind) {
    // receiveUpload accepted it, so this is defensive — but never keep bytes we
    // cannot classify.
    await unlink(upload.filePath).catch(() => {});
    return NextResponse.json(
      { error: `Could not classify "${upload.originalName}"`, code: "unsupported_type" },
      { status: 400 },
    );
  }

  const projectField = upload.fields.projectId?.trim();
  const projectId = projectField ? Number(projectField) : null;
  if (projectField && !Number.isInteger(projectId)) {
    await unlink(upload.filePath).catch(() => {});
    return NextResponse.json({ error: "projectId must be an integer", code: "bad_project" }, { status: 400 });
  }

  try {
    const asset = insertAsset({
      projectId,
      type: upload.fields.type?.trim() || kind,
      kind,
      mime: upload.mimeType,
      path: upload.filePath,
      originalName: upload.originalName,
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    await unlink(upload.filePath).catch(() => {});
    throw error;
  }
}
