import busboy from "busboy";

import { ALLOWED_VIDEO_TYPES } from "./allowed";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

/** SPEC.md § Feature checklist 1 — uploads are capped at 2 GB. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// The accepted-type table lives in a dependency-free module so the browser
// dropzone can pre-filter against the same rules this file enforces. Re-exported
// to keep it importable from here, where the enforcement actually happens.
export { ALLOWED_VIDEO_TYPES };

export type UploadErrorCode = "not_multipart" | "no_file" | "unsupported_type" | "too_large";

/** A client-caused upload failure; the API maps every one of these to a 400. */
export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export interface ReceivedUpload {
  /** Absolute-or-relative path the video was streamed to. */
  filePath: string;
  originalName: string;
  bytes: number;
  mimeType: string;
  /** Non-file form fields (e.g. `name`). */
  fields: Record<string, string>;
}

export interface ReceiveUploadOptions {
  uploadDir?: string;
  maxBytes?: number;
  /**
   * MIME → allowed-extensions map the upload is checked against. Defaults to
   * source-video types; the asset library passes a wider map (video/audio/
   * image). Same contract as `ALLOWED_VIDEO_TYPES`: the declared MIME type must
   * be a key AND the filename extension must be one it lists.
   */
  allowedTypes?: Readonly<Record<string, readonly string[]>>;
}

/** Where uploads land; overridable so tests never write into the real data dir. */
export function uploadDir(): string {
  return process.env.SSECLONE_UPLOAD_DIR ?? path.join("data", "uploads");
}

/** The effective size cap. `SSECLONE_MAX_UPLOAD_BYTES` overrides the 2 GB default. */
export function maxUploadBytes(): number {
  const raw = process.env.SSECLONE_MAX_UPLOAD_BYTES;
  if (raw === undefined) return MAX_UPLOAD_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_UPLOAD_BYTES;
}

function describeAllowed(allowedTypes: Readonly<Record<string, readonly string[]>>): string {
  return [...new Set(Object.values(allowedTypes).flat())].join(", ");
}

/**
 * Stream one video part of a multipart request to `uploadDir`, never holding the
 * whole file in memory (SPEC.md § Feature checklist 1; phase-02 requires ≤2 GB
 * streamed, not buffered).
 *
 * Two properties the implementation is built around:
 *  - the type check runs on busboy's `file` event, which fires with the headers
 *    BEFORE any body byte arrives, so a rejected type never touches disk;
 *  - hitting `maxBytes` destroys the source stream rather than draining it, so an
 *    oversize upload stops being read instead of writing 2 GB first.
 *
 * Any partially written file is unlinked before the returned promise rejects.
 */
export async function receiveUpload(
  request: Request,
  options: ReceiveUploadOptions = {},
): Promise<ReceivedUpload> {
  const dir = options.uploadDir ?? uploadDir();
  const maxBytes = options.maxBytes ?? maxUploadBytes();
  const allowedTypes = options.allowedTypes ?? ALLOWED_VIDEO_TYPES;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new UploadError("not_multipart", "Request must be multipart/form-data");
  }
  if (!request.body) {
    throw new UploadError("no_file", "Request body is empty");
  }

  await mkdir(dir, { recursive: true });

  const source = Readable.fromWeb(request.body as unknown as WebReadableStream<Uint8Array>);
  const bb = busboy({ headers: { "content-type": contentType }, limits: { files: 1, fileSize: maxBytes } });

  return new Promise<ReceivedUpload>((resolve, reject) => {
    const fields: Record<string, string> = {};
    let destPath: string | null = null;
    let writeDone: Promise<ReceivedUpload> | null = null;
    let fileStream: Readable | null = null;
    let settled = false;

    /** Stop reading the client, drop any partial file, then reject. */
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // Unpipe rather than destroying busboy: tearing it down mid-parse corrupts
      // its internal parser state and throws from inside streamsearch.
      source.unpipe(bb);
      source.destroy();
      // Busboy only ends a file stream when the parser reaches the part
      // boundary, which will never happen now the source is gone — destroy it so
      // the write pipeline settles instead of hanging.
      fileStream?.destroy();

      void (async () => {
        // Wait for the write to settle before unlinking. createWriteStream opens
        // the file asynchronously, so a fast rejection (e.g. a tiny size limit)
        // can otherwise unlink before the file exists and leave the completed
        // open() to orphan it.
        if (writeDone) await writeDone.catch(() => {});
        if (destPath) await unlink(destPath).catch(() => {});
        reject(error);
      })();
    };

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (_name, stream, info) => {
      fileStream = stream;
      const originalName = info.filename ?? "";
      const mimeType = (info.mimeType ?? "").toLowerCase();
      const ext = path.extname(originalName).toLowerCase();
      const allowedExts = allowedTypes[mimeType];

      // Runs before any file byte is read — nothing is written for a bad type.
      if (!allowedExts || !allowedExts.includes(ext)) {
        stream.resume();
        fail(
          new UploadError(
            "unsupported_type",
            `Unsupported file type "${mimeType || "unknown"}" (${originalName || "unnamed"}). Allowed: ${describeAllowed(allowedTypes)}`,
          ),
        );
        return;
      }

      const dest = path.join(dir, `${randomUUID()}${ext}`);
      destPath = dest;
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      stream.on("limit", () => {
        fail(new UploadError("too_large", `File exceeds the maximum upload size of ${maxBytes} bytes`));
      });

      writeDone = pipeline(stream, createWriteStream(dest)).then(() => ({
        filePath: dest,
        originalName,
        bytes,
        mimeType,
        fields,
      }));
      // A rejection here is surfaced on 'close'; keep it from going unhandled.
      writeDone.catch(() => {});
    });

    bb.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    // Fires once the body is parsed and every file stream has ended.
    bb.on("close", () => {
      if (settled) return;
      if (!writeDone) {
        fail(new UploadError("no_file", "No video file found in the upload"));
        return;
      }
      void writeDone.then(
        (received) => {
          if (settled) return;
          settled = true;
          resolve(received);
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
      );
    });

    source.on("error", (error) => fail(error));
    source.pipe(bb);
  });
}
