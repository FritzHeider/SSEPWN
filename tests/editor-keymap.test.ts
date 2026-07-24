import { describe, expect, it } from "vitest";

import { resolveKey, type KeyContext } from "../src/lib/editor/keymap";

const base: KeyContext = { activeTab: "captions", typing: false, helpOpen: false };
const timeline: KeyContext = { ...base, activeTab: "timeline" };

describe("resolveKey — playback & seeking", () => {
  it("Space toggles play", () => {
    expect(resolveKey({ key: " " }, base)).toEqual({ type: "toggle-play" });
  });

  it("arrows seek ∓1 s, Shift ∓5 s, Alt ∓0.1 s", () => {
    expect(resolveKey({ key: "ArrowLeft" }, base)).toEqual({ type: "seek", delta: -1 });
    expect(resolveKey({ key: "ArrowRight" }, base)).toEqual({ type: "seek", delta: 1 });
    expect(resolveKey({ key: "ArrowRight", shift: true }, base)).toEqual({ type: "seek", delta: 5 });
    expect(resolveKey({ key: "ArrowLeft", alt: true }, base)).toEqual({ type: "seek", delta: -0.1 });
  });
});

describe("resolveKey — undo/redo chords beat plain letters", () => {
  it("Cmd/Ctrl+Z is undo, +Shift is redo", () => {
    expect(resolveKey({ key: "z", meta: true }, base)).toEqual({ type: "undo" });
    expect(resolveKey({ key: "z", ctrl: true }, base)).toEqual({ type: "undo" });
    expect(resolveKey({ key: "z", meta: true, shift: true }, base)).toEqual({ type: "redo" });
  });

  it("leaves other modifier chords alone", () => {
    expect(resolveKey({ key: "a", meta: true }, base)).toBeNull();
  });
});

describe("resolveKey — tab-sensitive bindings", () => {
  it("I/O set trim in/out on the Timeline tab, else jump to clip in/out", () => {
    expect(resolveKey({ key: "i" }, timeline)).toEqual({ type: "set-in" });
    expect(resolveKey({ key: "o" }, timeline)).toEqual({ type: "set-out" });
    expect(resolveKey({ key: "i" }, base)).toEqual({ type: "jump-in" });
    expect(resolveKey({ key: "o" }, base)).toEqual({ type: "jump-out" });
  });

  it("S splits and Delete removes only on the Timeline tab", () => {
    expect(resolveKey({ key: "s" }, timeline)).toEqual({ type: "split" });
    expect(resolveKey({ key: "Delete" }, timeline)).toEqual({ type: "delete" });
    expect(resolveKey({ key: "Backspace" }, timeline)).toEqual({ type: "delete" });
    expect(resolveKey({ key: "s" }, base)).toBeNull();
    expect(resolveKey({ key: "Delete" }, base)).toBeNull();
  });
});

describe("resolveKey — help overlay & typing guard", () => {
  it("? toggles help; Escape closes it only when open", () => {
    expect(resolveKey({ key: "?" }, base)).toEqual({ type: "toggle-help" });
    expect(resolveKey({ key: "Escape" }, { ...base, helpOpen: true })).toEqual({ type: "close-help" });
    expect(resolveKey({ key: "Escape" }, base)).toBeNull();
  });

  it("ignores every key while typing, except Escape to close help", () => {
    const typing: KeyContext = { ...timeline, typing: true, helpOpen: true };
    expect(resolveKey({ key: " " }, typing)).toBeNull();
    expect(resolveKey({ key: "s" }, typing)).toBeNull();
    expect(resolveKey({ key: "z", meta: true }, typing)).toBeNull();
    expect(resolveKey({ key: "Escape" }, typing)).toEqual({ type: "close-help" });
  });
});
