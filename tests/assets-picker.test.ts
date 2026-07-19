import { describe, expect, it } from "vitest";

import {
  acceptedExtensions,
  assetInputAccept,
  assetLabel,
  assetMeta,
  assetThumbnailUrl,
  assetsListUrl,
  hasThumbnail,
  hasUnprobedThumbnails,
  kindLabel,
  parseAssetsResponse,
  validatePickedFile,
  type PickerAsset,
} from "../src/lib/assets/picker";

function asset(overrides: Partial<PickerAsset> = {}): PickerAsset {
  return {
    id: 1,
    kind: "video",
    type: "broll",
    mime: "video/mp4",
    originalName: "clip.mp4",
    width: 1920,
    height: 1080,
    duration: 12.4,
    thumbnailPath: "/data/thumbnails/asset-1.jpg",
    ...overrides,
  };
}

describe("kindLabel", () => {
  it("title-cases each kind", () => {
    expect(kindLabel("video")).toBe("Video");
    expect(kindLabel("audio")).toBe("Audio");
    expect(kindLabel("image")).toBe("Image");
  });
});

describe("assetLabel", () => {
  it("uses the trimmed original name when present", () => {
    expect(assetLabel(asset({ originalName: "  My B-roll.mp4  " }))).toBe("My B-roll.mp4");
  });

  it("falls back to a stable kind + id when unnamed", () => {
    expect(assetLabel(asset({ originalName: null, kind: "audio", id: 7 }))).toBe("Audio #7");
    expect(assetLabel(asset({ originalName: "   ", kind: null, id: 9 }))).toBe("Asset #9");
  });
});

describe("assetMeta", () => {
  it("joins resolution and duration for a probed video", () => {
    expect(assetMeta(asset())).toBe("1920×1080 · 0:12");
  });

  it("shows only duration for audio (no dimensions)", () => {
    expect(assetMeta(asset({ kind: "audio", width: null, height: null, duration: 3 }))).toBe("0:03");
  });

  it("shows only resolution for an un-probed-duration image", () => {
    expect(assetMeta(asset({ kind: "image", duration: null }))).toBe("1920×1080");
  });

  it("is empty until anything is probed", () => {
    expect(assetMeta(asset({ width: null, height: null, duration: null }))).toBe("");
  });
});

describe("thumbnails", () => {
  it("hasThumbnail reflects the poster path", () => {
    expect(hasThumbnail(asset())).toBe(true);
    expect(hasThumbnail(asset({ thumbnailPath: null }))).toBe(false);
  });

  it("assetThumbnailUrl points at the serve route only when a poster exists", () => {
    expect(assetThumbnailUrl(asset({ id: 42 }))).toBe("/api/assets/42/thumbnail");
    expect(assetThumbnailUrl(asset({ thumbnailPath: null }))).toBeNull();
  });
});

describe("assetsListUrl", () => {
  it("scopes the library query to a kind", () => {
    expect(assetsListUrl("audio")).toBe("/api/assets?kind=audio");
  });
});

describe("accept helpers", () => {
  it("acceptedExtensions returns only that kind's extensions, de-duplicated", () => {
    expect(acceptedExtensions("image").sort()).toEqual([".jpeg", ".jpg", ".png", ".webp"]);
    // .m4a appears under two audio MIME types but must not be listed twice.
    expect(acceptedExtensions("audio").filter((e) => e === ".m4a")).toHaveLength(1);
  });

  it("assetInputAccept lists MIME types AND extensions for the kind", () => {
    const accept = assetInputAccept("video");
    expect(accept).toContain("video/mp4");
    expect(accept).toContain(".mov");
    // No cross-kind leakage.
    expect(accept).not.toContain("audio/");
    expect(accept).not.toContain(".png");
  });
});

describe("validatePickedFile", () => {
  it("accepts a matching file", () => {
    expect(validatePickedFile({ name: "b.mp4", type: "video/mp4" }, "video")).toBeNull();
  });

  it("rejects an unsupported file", () => {
    const msg = validatePickedFile({ name: "notes.txt", type: "text/plain" }, "video");
    expect(msg).toContain("not a supported video");
  });

  it("rejects a supported file of the wrong kind", () => {
    const msg = validatePickedFile({ name: "song.mp3", type: "audio/mpeg" }, "video");
    expect(msg).toContain("audio file");
    expect(msg).toContain("video asset is expected");
  });

  it("rejects a mime/extension mismatch (renamed file)", () => {
    expect(validatePickedFile({ name: "evil.png", type: "video/mp4" }, "video")).not.toBeNull();
  });
});

describe("hasUnprobedThumbnails", () => {
  it("is true while a visual asset still lacks a poster", () => {
    expect(hasUnprobedThumbnails([asset({ thumbnailPath: null })])).toBe(true);
    expect(hasUnprobedThumbnails([asset({ kind: "image", thumbnailPath: null })])).toBe(true);
  });

  it("ignores audio, which never gets a poster", () => {
    expect(hasUnprobedThumbnails([asset({ kind: "audio", thumbnailPath: null })])).toBe(false);
  });

  it("is false once every visual asset is probed", () => {
    expect(hasUnprobedThumbnails([asset(), asset({ kind: "audio", thumbnailPath: null })])).toBe(false);
  });
});

describe("parseAssetsResponse", () => {
  it("narrows a well-formed body and drops non-picker fields", () => {
    const parsed = parseAssetsResponse({
      assets: [
        { id: 3, kind: "image", type: "logo", mime: "image/png", originalName: "logo.png", width: 320, height: 240, duration: null, thumbnailPath: "/t/asset-3.jpg", path: "/secret/on/disk.png", createdAt: 100 },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: 3,
      kind: "image",
      type: "logo",
      mime: "image/png",
      originalName: "logo.png",
      width: 320,
      height: 240,
      duration: null,
      thumbnailPath: "/t/asset-3.jpg",
    });
    expect(parsed[0]).not.toHaveProperty("path");
  });

  it("drops rows without a numeric id and coerces bad kinds to null", () => {
    const parsed = parseAssetsResponse({
      assets: [
        { id: "x", kind: "video" },
        { id: 5, kind: "nonsense", type: 7, width: "big", duration: Number.NaN },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(5);
    expect(parsed[0].kind).toBeNull();
    expect(parsed[0].type).toBe("");
    expect(parsed[0].width).toBeNull();
    expect(parsed[0].duration).toBeNull();
  });

  it("returns [] for a malformed body", () => {
    expect(parseAssetsResponse(null)).toEqual([]);
    expect(parseAssetsResponse({})).toEqual([]);
    expect(parseAssetsResponse({ assets: "nope" })).toEqual([]);
  });
});
