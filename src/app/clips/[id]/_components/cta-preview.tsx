"use client";

import type { CSSProperties } from "react";

import type { CtaOverlay } from "@/lib/timeline/cta";
import { activeCtaAt, ctaAnchor, ctaAnimState, ctaFontSizeCqh, ctaImageUrl } from "@/lib/timeline/cta-view";
import type { TimelineDoc } from "@/lib/timeline/types";

/**
 * One CTA overlay layer: an anchored box (9-grid cell + normalised offset) holding
 * a text card or an image, with the in/out CSS keyframe animation scrubbed to the
 * current playhead. The outer element owns the anchor centring (`translate(%)`);
 * the inner `.cta-anim` element owns the keyframe animation (opacity + a small
 * translate) so the two transforms never collide. Preview approximates —
 * `renderPlan` is the ground truth (SPEC Phase 08).
 */
function CtaLayer({ cta, playhead, playing }: { cta: CtaOverlay; playhead: number; playing: boolean }) {
  const anchor = ctaAnchor(cta);
  const anim = ctaAnimState(cta, playhead);

  const boxStyle: CSSProperties = {
    position: "absolute",
    left: `${anchor.left}%`,
    top: `${anchor.top}%`,
    transform: `translate(${anchor.translateX}%, ${anchor.translateY}%)`,
    fontSize: `${ctaFontSizeCqh(cta)}cqh`,
    maxWidth: "80%",
  };

  const animStyle: CSSProperties = anim.name
    ? {
        animationName: anim.name,
        animationDuration: `${anim.duration}s`,
        animationTimingFunction: "ease",
        animationFillMode: "both",
        animationDelay: `-${anim.elapsed}s`,
        animationPlayState: playing ? "running" : "paused",
      }
    : {};

  return (
    <div style={boxStyle} data-testid="cta-preview" data-cta-id={cta.id} data-cta-variant={cta.variant}>
      <div className="cta-anim" style={animStyle}>
        {cta.variant === "image" && cta.assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- local asset bytes, no Next loader
          <img
            src={ctaImageUrl(cta.assetId)}
            alt=""
            style={{ display: "block", width: "100%", height: "auto", borderRadius: "0.25em" }}
          />
        ) : (
          <span
            style={{
              display: "inline-block",
              whiteSpace: "pre-wrap",
              padding: "0.35em 0.7em",
              borderRadius: "0.4em",
              lineHeight: 1.2,
              fontFamily: cta.style.fontFamily,
              color: cta.style.color,
              background: cta.style.background,
            }}
          >
            {cta.content}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The CTA preview overlay: every CTA active at the playhead, rendered over the
 * main `<video>` inside the same `relative` frame wrapper as the B-roll overlay.
 * `container-type: size` makes `1cqh` equal 1% of the frame height so text scales
 * with the frame; `pointer-events-none` keeps the transport clickable.
 */
export function CtaPreview({
  doc,
  playhead,
  playing,
}: {
  doc: TimelineDoc;
  playhead: number;
  playing: boolean;
}) {
  const active = activeCtaAt(doc, playhead);
  if (active.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ containerType: "size" }}
      data-testid="cta-overlay"
    >
      {active.map((cta) => (
        <CtaLayer key={cta.id} cta={cta} playhead={playhead} playing={playing} />
      ))}
    </div>
  );
}
