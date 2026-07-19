import { describe, expect, it } from "vitest";

import { addCta } from "../src/lib/timeline/cta";
import {
  activeCtaAt,
  ctaAnchor,
  ctaAnimDuration,
  ctaAnimName,
  ctaAnimState,
  ctaColumn,
  ctaFontSizeCqh,
  ctaImageUrl,
  ctaRow,
  CTA_ANCHOR_MARGIN,
} from "../src/lib/timeline/cta-view";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** A 20s timeline with two text CTAs: [2,6) bottom-center, [6,10) top-left. */
function docWithTwoCta(): TimelineDoc {
  let d = buildTimelineDoc(0, 20);
  d = addCta(d, { variant: "text", content: "first", start: 2, end: 6, position: "bottom-center" });
  d = addCta(d, {
    variant: "text",
    content: "second",
    start: 6,
    end: 10,
    position: "top-left",
    animIn: "slide",
    animOut: "fade",
  });
  return d;
}

describe("ctaImageUrl", () => {
  it("points at the shared asset file-serving route", () => {
    expect(ctaImageUrl(42)).toBe("/api/assets/42/file");
  });
});

describe("activeCtaAt", () => {
  const d = docWithTwoCta();

  it("returns the overlay covering the playhead", () => {
    expect(activeCtaAt(d, 3).map((c) => c.content)).toEqual(["first"]);
    expect(activeCtaAt(d, 8).map((c) => c.content)).toEqual(["second"]);
  });

  it("is empty before and after all overlays", () => {
    expect(activeCtaAt(d, 0)).toEqual([]);
    expect(activeCtaAt(d, 15)).toEqual([]);
  });

  it("treats the range as half-open so abutting overlays never both fire", () => {
    expect(activeCtaAt(d, 6).map((c) => c.content)).toEqual(["second"]);
    expect(activeCtaAt(d, 10)).toEqual([]);
  });
});

describe("ctaRow / ctaColumn", () => {
  it("splits the 9-grid position into row and column", () => {
    expect(ctaRow("bottom-center")).toBe("bottom");
    expect(ctaColumn("bottom-center")).toBe("center");
    expect(ctaRow("top-left")).toBe("top");
    expect(ctaColumn("middle-right")).toBe("right");
  });
});

describe("ctaAnchor", () => {
  it("centres a bottom-center overlay on its cell", () => {
    expect(ctaAnchor({ position: "bottom-center", offset: { x: 0, y: 0 } })).toEqual({
      left: 50,
      top: 100 - CTA_ANCHOR_MARGIN,
      translateX: -50,
      translateY: -100,
    });
  });

  it("hangs a top-left overlay off the inset corner", () => {
    expect(ctaAnchor({ position: "top-left", offset: { x: 0, y: 0 } })).toEqual({
      left: CTA_ANCHOR_MARGIN,
      top: CTA_ANCHOR_MARGIN,
      translateX: 0,
      translateY: 0,
    });
  });

  it("nudges the anchor by the normalised offset (percent of frame)", () => {
    const a = ctaAnchor({ position: "middle-center", offset: { x: 0.1, y: -0.2 } });
    expect(a).toEqual({ left: 60, top: 30, translateX: -50, translateY: -50 });
  });
});

describe("ctaFontSizeCqh", () => {
  it("expresses the frame-height fraction in container-query height units", () => {
    expect(ctaFontSizeCqh({ style: { fontFamily: "x", fontSize: 0.06, color: "#fff", background: "#000" } })).toBe(6);
  });
});

describe("ctaAnimDuration", () => {
  it("is the default for a long overlay", () => {
    expect(ctaAnimDuration({ start: 0, end: 10 })).toBe(0.4);
  });

  it("never exceeds half the span so in/out windows stay disjoint", () => {
    expect(ctaAnimDuration({ start: 0, end: 0.5 })).toBe(0.25);
  });
});

describe("ctaAnimName", () => {
  it("maps fade to directional fade keyframes", () => {
    expect(ctaAnimName("fade", "in", "bottom")).toBe("cta-fade-in");
    expect(ctaAnimName("fade", "out", "top")).toBe("cta-fade-out");
  });

  it("slides in from the anchored vertical edge", () => {
    expect(ctaAnimName("slide", "in", "top")).toBe("cta-slide-in-down");
    expect(ctaAnimName("slide", "in", "bottom")).toBe("cta-slide-in-up");
    expect(ctaAnimName("slide", "out", "top")).toBe("cta-slide-out-up");
    expect(ctaAnimName("slide", "out", "middle")).toBe("cta-slide-out-down");
  });

  it("is null for none (the CTA snaps)", () => {
    expect(ctaAnimName("none", "in", "top")).toBeNull();
  });
});

describe("ctaAnimState", () => {
  const d = docWithTwoCta();
  const second = activeCtaAt(d, 7)[0]; // [6,10) slide-in / fade-out, top-left

  it("plays the in animation near the start, scrubbed to the elapsed frame", () => {
    const s = ctaAnimState(second, 6.1);
    expect(s.name).toBe("cta-slide-in-down");
    expect(s.duration).toBe(0.4);
    expect(s.elapsed).toBeCloseTo(0.1, 5);
  });

  it("plays the out animation near the end", () => {
    const s = ctaAnimState(second, 9.8);
    expect(s.name).toBe("cta-fade-out");
    expect(s.elapsed).toBeCloseTo(0.2, 5); // t - (end - d) = 9.8 - 9.6
  });

  it("has no animation in the steady middle", () => {
    expect(ctaAnimState(second, 8).name).toBeNull();
  });

  it("returns no in-animation when animIn is none", () => {
    const first = activeCtaAt(d, 3)[0]; // animIn none
    expect(ctaAnimState(first, 2.1).name).toBeNull();
  });
});
