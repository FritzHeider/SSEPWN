import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { receiveUpload } from "../src/lib/upload/receive";

/**
 * These tests exist because the route-level suite cannot see the property the
 * phase actually cares about: "streamed to data/uploads/, never buffered fully
 * in memory". A `receiveUpload` that read the request into one Buffer and then
 * wrote it out would pass every assertion in upload-api.test.ts. So instead of
 * asserting on the finished file, these drive the request body by hand and
 * assert on WHEN bytes hit disk and on how much of the body is ever read.
 */

const BOUNDARY = "----sseclonetest";
const encoder = new TextEncoder();

let uploadsDir: string;

function partHeader(filename: string, mimeType: string): Uint8Array {
  return encoder.encode(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
}

function partFooter(): Uint8Array {
  return encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
}

function streamingRequest(body: ReadableStream<Uint8Array>): Request {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    // Required by undici to send a stream as the request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** Total bytes currently written across the upload dir. */
function bytesOnDisk(): number {
  return readdirSync(uploadsDir).reduce((sum, file) => sum + statSync(path.join(uploadsDir, file)).size, 0);
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  uploadsDir = mkdtempSync(path.join(tmpdir(), "sseclone-stream-"));
});

afterEach(() => {
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe("receiveUpload streaming behaviour", () => {
  it("writes bytes to disk while the request body is still open", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let releaseTail!: () => void;
    const tailHeld = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    let finished = false;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(partHeader("big.mp4", "video/mp4"));
        controller.enqueue(chunk);
        // Hold the request open: a buffering implementation cannot have written
        // anything yet, because it has not seen the end of the body.
        await tailHeld;
        controller.enqueue(partFooter());
        controller.close();
        finished = true;
      },
    });

    const pending = receiveUpload(streamingRequest(body), { uploadDir: uploadsDir, maxBytes: 10 * 1024 * 1024 });

    await waitFor(() => bytesOnDisk() >= chunk.byteLength, "the first chunk to reach disk");
    expect(finished, "body must still be open while bytes are on disk").toBe(false);

    releaseTail();
    const received = await pending;
    expect(received.bytes).toBe(chunk.byteLength);
    expect(statSync(received.filePath).size).toBe(chunk.byteLength);
  });

  it("stops reading the body once the size limit is exceeded", async () => {
    const chunkSize = 64 * 1024;
    const maxBytes = 256 * 1024;
    let pulled = 0;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partHeader("huge.mp4", "video/mp4"));
      },
      pull(controller) {
        // An effectively endless upload: 64 MB if it is ever fully drained.
        if (pulled >= 1024) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkSize).fill(1));
      },
    });

    await expect(
      receiveUpload(streamingRequest(body), { uploadDir: uploadsDir, maxBytes }),
    ).rejects.toThrow(/maximum upload size/);

    // The point: it aborted instead of draining the client. Allow generous slack
    // for stream buffering, but 64 MB worth of chunks must never be read.
    expect(pulled).toBeLessThan(200);
    // And no partial file is left lying around.
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("writes nothing at all for a rejected file type", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partHeader("payload.txt", "text/plain"));
        controller.enqueue(new Uint8Array(1024 * 512).fill(3));
        controller.enqueue(partFooter());
        controller.close();
      },
    });

    await expect(
      receiveUpload(streamingRequest(body), { uploadDir: uploadsDir, maxBytes: 10 * 1024 * 1024 }),
    ).rejects.toThrow(/Unsupported file type/);

    // The type check runs on the part headers, before any byte is written.
    expect(readdirSync(uploadsDir)).toEqual([]);
  });
});
