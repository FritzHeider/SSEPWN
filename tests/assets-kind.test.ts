import { describe, expect, it } from "vitest";

import {
  allowedAssetExtensions,
  assetAllowedTypesMap,
  assetKind,
  ASSET_KINDS,
  isAcceptedAssetFile,
  isAssetKind,
} from "../src/lib/assets/kind";

describe("assetKind", () => {
  it("classifies video, audio, and image when mime and extension agree", () => {
    expect(assetKind("video/mp4", ".mp4")).toBe("video");
    expect(assetKind("video/webm", ".webm")).toBe("video");
    expect(assetKind("audio/mpeg", ".mp3")).toBe("audio");
    expect(assetKind("audio/wav", ".wav")).toBe("audio");
    expect(assetKind("image/png", ".png")).toBe("image");
    expect(assetKind("image/jpeg", ".jpg")).toBe("image");
    expect(assetKind("image/jpeg", ".jpeg")).toBe("image");
  });

  it("is case-insensitive on both mime and extension", () => {
    expect(assetKind("VIDEO/MP4", ".MP4")).toBe("video");
    expect(assetKind("Image/PNG", ".PNG")).toBe("image");
  });

  it("rejects types outside the video/audio/image allow-list", () => {
    expect(assetKind("application/pdf", ".pdf")).toBeNull();
    expect(assetKind("text/plain", ".txt")).toBeNull();
    expect(assetKind("application/octet-stream", ".bin")).toBeNull();
    expect(assetKind("", "")).toBeNull();
  });

  it("rejects a mismatched extension even when the mime is known", () => {
    expect(assetKind("video/mp4", ".mov")).toBeNull();
    expect(assetKind("image/png", ".jpg")).toBeNull();
    expect(assetKind("audio/mpeg", ".wav")).toBeNull();
  });
});

describe("asset kind helpers", () => {
  it("isAssetKind guards the three kinds only", () => {
    expect(ASSET_KINDS).toEqual(["video", "audio", "image"]);
    for (const k of ASSET_KINDS) expect(isAssetKind(k)).toBe(true);
    expect(isAssetKind("logo")).toBe(false);
    expect(isAssetKind(null)).toBe(false);
    expect(isAssetKind(3)).toBe(false);
  });

  it("assetAllowedTypesMap is a flat mime→exts map consistent with assetKind", () => {
    const map = assetAllowedTypesMap();
    expect(map["video/mp4"]).toEqual([".mp4"]);
    expect(map["audio/mpeg"]).toEqual([".mp3"]);
    for (const [mime, exts] of Object.entries(map)) {
      for (const ext of exts) expect(assetKind(mime, ext)).not.toBeNull();
    }
  });

  it("allowedAssetExtensions is de-duplicated", () => {
    const exts = allowedAssetExtensions();
    expect(new Set(exts).size).toBe(exts.length);
    expect(exts).toContain(".mp4");
    expect(exts).toContain(".mp3");
    expect(exts).toContain(".png");
  });

  it("isAcceptedAssetFile mirrors the server rule for a browser File shape", () => {
    expect(isAcceptedAssetFile({ name: "clip.mp4", type: "video/mp4" })).toBe(true);
    expect(isAcceptedAssetFile({ name: "logo.png", type: "image/png" })).toBe(true);
    expect(isAcceptedAssetFile({ name: "doc.pdf", type: "application/pdf" })).toBe(false);
    expect(isAcceptedAssetFile({ name: "clip.mov", type: "video/mp4" })).toBe(false);
  });
});
