"use client";

import { thumbLineStyle, thumbWords, thumbnailScale } from "@/lib/templates/thumbnail";
import type { CaptionStyle } from "@/lib/captions/style";

/**
 * A live 9:16 style thumbnail for a template (item 27): a small dark tile showing
 * a few sample caption words styled from the template's stored {@link CaptionStyle}
 * — font size, colours, outline, and the brand highlight on the middle word — so
 * the gallery previews the actual look rather than plain swatches. All the
 * style→CSS mapping is the pure `templates/thumbnail` helper, reused from the live
 * caption overlay so the preview cannot drift from what burns in.
 */
export function TemplateThumb({
  style,
  className,
}: {
  style: CaptionStyle;
  className?: string;
}) {
  // The tile is ~112px tall; scale the reference-height caption pixels down to it.
  const TILE_HEIGHT = 112;
  const scale = thumbnailScale(TILE_HEIGHT);
  const words = thumbWords(style, scale);

  return (
    <div
      data-testid="template-thumb"
      aria-hidden
      className={`flex items-center justify-center overflow-hidden rounded bg-black ${className ?? ""}`}
      style={{ aspectRatio: "9 / 16", height: TILE_HEIGHT }}
    >
      <div style={thumbLineStyle(style, scale)}>
        {words.map((w, i) => (
          <span key={i} style={w.style}>
            {w.text}
            {i < words.length - 1 ? " " : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
