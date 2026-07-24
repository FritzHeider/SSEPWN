"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { CaptionDoc } from "@/lib/captions/ass";
import type { CaptionEdit } from "@/lib/captions/edit";
import { activeLineIndex, editorLines } from "@/lib/captions/preview";
import type { CaptionStyleInput } from "@/lib/captions/style";

/** Reference video height when the project's is unknown (the ASS design height). */
export const FALLBACK_REFERENCE_HEIGHT = 1080;

/**
 * The caption editor's document state + server sync, extracted from the old
 * `CaptionEditor` so the single shared `<video>` (owned by `EditorShell`) renders
 * the live overlay and the caption list. The document is server truth: every
 * mutation goes through `PATCH /api/clips/:id/captions` and the whole doc is
 * replaced from the response (the same "re-read the server" discipline as before).
 * The player CLOCK (`relTime`, `scale`) is owned by the shell — this hook only
 * owns the document and the word-editing interaction.
 */
export function useCaptions({
  videoRef,
  clipId,
  inPoint,
  initialDoc,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  clipId: number;
  inPoint: number;
  initialDoc: CaptionDoc;
}) {
  const [doc, setDoc] = useState<CaptionDoc>(initialDoc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ line: number; word: number } | null>(null);
  const [draft, setDraft] = useState("");

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const lines = useMemo(() => editorLines(doc), [doc]);

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
      if (video) video.currentTime = inPoint + start;
    },
    [inPoint, videoRef],
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

  const activeLine = useCallback((relTime: number) => activeLineIndex(lines, relTime), [lines]);

  return {
    doc,
    lines,
    busy,
    error,
    editing,
    draft,
    setDraft,
    setEditing,
    patch,
    seekToLine,
    beginEdit,
    commitEdit,
    onStyle,
    activeLine,
  };
}

export type CaptionsController = ReturnType<typeof useCaptions>;
