"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { StylePanel } from "./style-panel";
import type { CaptionDoc } from "@/lib/captions/ass";
import type { CaptionEdit } from "@/lib/captions/edit";
import {
  activeCue,
  activeLineIndex,
  activeWordIndex,
  clipRelativeTime,
  displayText,
  editorLines,
  overlayLineStyle,
  overlayWordStyle,
  overlayWrapperStyle,
} from "@/lib/captions/preview";
import type { CaptionStyleInput } from "@/lib/captions/style";
import { formatDuration } from "@/lib/projects/view";
import { sourceVideoUrl } from "@/lib/transcribe/panel";

/** Reference video height when the project's is unknown (the ASS design height). */
const FALLBACK_REFERENCE_HEIGHT = 1080;

/**
 * The clip caption editor: one player, a live style overlay, a caption list
 * synced to the playhead, and a style panel — the Phase 05 clip-editor UI.
 *
 * The document is server truth. Every mutation goes through `PATCH
 * /api/clips/:id/captions`, whose response is the new document; we replace the
 * whole doc from that response rather than patching it locally (the same
 * "re-read the server" discipline the clips panel uses) so the list, overlay and
 * style panel can never drift from what is stored. Word edits stay clip-local by
 * construction — the route only writes `clip_edits`.
 *
 * The player loops the clip window `[inPoint, outPoint]`, and everything
 * "active" is computed from clip-relative time (`currentTime − inPoint`) against
 * the clip-relative caption timings, so the overlay's karaoke sweep and the
 * highlighted list row stay locked to the frame on screen.
 */
export function CaptionEditor({
  clipId,
  projectId,
  inPoint,
  outPoint,
  referenceHeight,
  initialDoc,
}: {
  clipId: number;
  projectId: number;
  inPoint: number;
  outPoint: number;
  referenceHeight: number | null;
  initialDoc: CaptionDoc;
}) {
  const [doc, setDoc] = useState<CaptionDoc>(initialDoc);
  const [relTime, setRelTime] = useState(0);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ line: number; word: number } | null>(null);
  const [draft, setDraft] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const lines = useMemo(() => editorLines(doc), [doc]);
  const activeLine = activeLineIndex(lines, relTime);
  const cue = activeCue(doc, relTime);

  // Position the player at the clip's in-point on first load.
  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = inPoint;
    const reference = referenceHeight ?? video.videoHeight ?? FALLBACK_REFERENCE_HEIGHT;
    if (video.clientHeight > 0 && reference > 0) setScale(video.clientHeight / reference);
  }, [inPoint, referenceHeight]);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Loop the clip window so the caption preview keeps cycling; a running
    // preview past the out-point jumps back to the in-point.
    if (video.currentTime >= outPoint || video.currentTime < inPoint - 0.25) {
      video.currentTime = inPoint;
    }
    setRelTime(clipRelativeTime(video.currentTime, inPoint));
  }, [inPoint, outPoint]);

  // Keep the overlay scale in step with the player's rendered size.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => {
      const reference = referenceHeight ?? video.videoHeight ?? FALLBACK_REFERENCE_HEIGHT;
      if (video.clientHeight > 0 && reference > 0) setScale(video.clientHeight / reference);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    return () => observer.disconnect();
  }, [referenceHeight]);

  const patch = useCallback(
    async (edit: CaptionEdit) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/clips/${clipId}/captions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(edit),
        });
        if (!response.ok) throw new Error(`Edit failed (${response.status})`);
        const body = (await response.json()) as { captions: CaptionDoc };
        if (alive.current) setDoc(body.captions);
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : "Edit failed");
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [clipId],
  );

  const seekToLine = useCallback(
    (start: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = inPoint + start;
    },
    [inPoint],
  );

  const beginEdit = useCallback((line: number, word: number, text: string) => {
    setEditing({ line, word });
    setDraft(text);
  }, []);

  const commitEdit = useCallback(() => {
    if (!editing) return;
    const text = draft.trim();
    const current = lines[editing.line]?.line.words[editing.word]?.text;
    setEditing(null);
    if (text.length > 0 && text !== current) {
      void patch({ op: "set-word", line: editing.line, word: editing.word, text });
    }
  }, [editing, draft, lines, patch]);

  const onStyle = useCallback(
    (overrides: CaptionStyleInput) => void patch({ op: "set-style", style: overrides }),
    [patch],
  );

  const style = doc.style;

  return (
    <div className="flex flex-col gap-8">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={sourceVideoUrl(projectId)}
          controls
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          className="w-full"
        />
        {/* Live HTML/CSS approximation of the burned-in captions (Phase 10 does
            the exact ASS render). Only the active cue is shown. */}
        {cue ? (
          <div style={overlayWrapperStyle(style, scale)}>
            <div className="flex flex-col items-center gap-1">
              {cue.lines.map((cueLine, i) => (
                <div key={i} style={overlayLineStyle(style, scale)}>
                  {cueLine.words.map((w, wi) => {
                    const active = activeWordIndex(cueLine, relTime) === wi;
                    return (
                      <span key={wi} style={overlayWordStyle(style, active, scale)}>
                        {displayText(w.text, style)}
                        {wi < cueLine.words.length - 1 ? " " : ""}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      <StylePanel style={style} activePreset={doc.name} disabled={busy} onStyle={onStyle} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Captions
        </h2>

        {lines.length === 0 ? (
          <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            No captions for this clip — it has no transcribed speech in its range.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {lines.map(({ index, line }) => (
              <li
                key={index}
                aria-current={index === activeLine ? "true" : undefined}
                className={`flex flex-col gap-2 rounded-lg border p-3 ${
                  index === activeLine
                    ? "border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/40"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => seekToLine(line.start)}
                    className="font-mono tabular-nums text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    {formatDuration(line.start)}
                  </button>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => patch({ op: "shift-line", line: index, delta: -0.1 })}
                      className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      aria-label={`Shift line ${index + 1} earlier`}
                    >
                      −0.1s
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => patch({ op: "shift-line", line: index, delta: 0.1 })}
                      className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      aria-label={`Shift line ${index + 1} later`}
                    >
                      +0.1s
                    </button>
                    <button
                      type="button"
                      disabled={busy || index >= lines.length - 1}
                      onClick={() => patch({ op: "merge-line", line: index })}
                      className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      Merge ↓
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-sm">
                  {line.words.map((w, wi) => (
                    <span key={wi} className="flex items-center">
                      {wi > 0 ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => patch({ op: "split-line", line: index, word: wi })}
                          aria-label={`Split line ${index + 1} before "${w.text}"`}
                          title="Split line here"
                          className="mr-1 text-zinc-300 hover:text-blue-600 disabled:opacity-50 dark:text-zinc-600"
                        >
                          |
                        </button>
                      ) : null}
                      {editing && editing.line === index && editing.word === wi ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-24 rounded border border-blue-400 bg-white px-1 py-0.5 text-sm dark:bg-zinc-900"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => beginEdit(index, wi, w.text)}
                          className={`rounded px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                            index === activeLine && activeWordIndex(line, relTime) === wi
                              ? "font-semibold text-blue-700 dark:text-blue-300"
                              : "text-zinc-800 dark:text-zinc-200"
                          }`}
                        >
                          {w.text}
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
