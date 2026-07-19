"use client";

import { useCallback, useEffect, useRef } from "react";

import { sfxAssetUrl, sfxSchedule } from "@/lib/timeline/sfx-view";
import type { TimelineDoc } from "@/lib/timeline/types";

/**
 * The SFX WebAudio preview (Phase 08). Renders no DOM — it lives alongside
 * `<BrollPreview>`/`<CtaPreview>` purely to schedule sound-effect cues on the
 * shared `AudioContext` when the main transport plays. Each asset is fetched and
 * decoded once (cached by id); on play, every cue at or after the current playhead
 * is scheduled at `now + offset` through its own gain node; on pause/stop or a doc
 * edit every scheduled source is stopped. Preview approximates — `renderPlan` is
 * the ground truth (SPEC Phase 08), so ducking is not applied here.
 */
export function SfxPreview({
  doc,
  playhead,
  playing,
}: {
  doc: TimelineDoc;
  playhead: number;
  playing: boolean;
}) {
  const playheadRef = useRef(playhead);
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Map<number, AudioBuffer>>(new Map());
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Mirror the live playhead so the play-start effect can read where playback
  // begins without re-running on every frame while playing.
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  // Fetch + decode an asset once, caching the buffer by id.
  const loadBuffer = useCallback(async (ctx: AudioContext, assetId: number): Promise<AudioBuffer> => {
    const cached = buffersRef.current.get(assetId);
    if (cached) return cached;
    const response = await fetch(sfxAssetUrl(assetId));
    if (!response.ok) throw new Error(`SFX asset ${assetId} unavailable`);
    const bytes = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    buffersRef.current.set(assetId, buffer);
    return buffer;
  }, []);

  const stopAll = useCallback(() => {
    for (const source of sourcesRef.current) {
      try {
        source.stop();
      } catch {
        /* already stopped/ended */
      }
    }
    sourcesRef.current = [];
  }, []);

  // Schedule (on play) / tear down (on pause, doc edit, unmount).
  useEffect(() => {
    if (!playing) {
      stopAll();
      return;
    }
    if (typeof window === "undefined" || !window.AudioContext) return;
    const ctx = ctxRef.current ?? (ctxRef.current = new window.AudioContext());
    void ctx.resume();

    const startAt = ctx.currentTime;
    const cues = sfxSchedule(doc, playheadRef.current);
    let cancelled = false;

    void (async () => {
      for (const cue of cues) {
        try {
          const buffer = await loadBuffer(ctx, cue.assetId);
          if (cancelled) return;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          const gain = ctx.createGain();
          gain.gain.value = cue.gain;
          source.connect(gain).connect(ctx.destination);
          source.start(Math.max(startAt + cue.offset, ctx.currentTime));
          sourcesRef.current.push(source);
        } catch {
          /* preview is best-effort: skip a cue we cannot fetch/decode */
        }
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
  }, [playing, doc, loadBuffer, stopAll]);

  // Close the AudioContext when the editor unmounts.
  useEffect(
    () => () => {
      stopAll();
      void ctxRef.current?.close();
    },
    [stopAll],
  );

  return null;
}
