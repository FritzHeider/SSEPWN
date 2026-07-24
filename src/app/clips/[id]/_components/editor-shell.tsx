"use client";

import { Clapperboard, Crop, Download, LayoutTemplate, Scissors, Type } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CaptionsTab } from "./captions-tab";
import { CropTab } from "./crop-tab";
import { EditorTabs, type TabDef } from "./editor-tabs";
import { ExportPanel } from "./export-panel";
import { PlayerStage, type ExportPreview } from "./player-stage";
import { ShortcutsOverlay } from "./shortcuts-overlay";
import { TemplatePanel } from "./template-panel";
import { TimelineStrip } from "./timeline-strip";
import { TimelineTab } from "./timeline-tab";
import { TransportBar } from "./transport-bar";
import { useCaptions } from "./use-captions";
import { useCrop } from "./use-crop";
import { useTimeline } from "./use-timeline";
import type { CaptionDoc } from "@/lib/captions/ass";
import { clipRelativeTime, activeCue } from "@/lib/captions/preview";
import { aspectRatioValue } from "@/lib/crop/types";
import type { CropState } from "@/lib/crop/state";
import { resolveKey, type EditorTab } from "@/lib/editor/keymap";
import type { ExportRow } from "@/lib/export/view";
import { resolvePresetSelection, type PlatformPresetId } from "@/lib/presets";
import type { Template } from "@/lib/templates/types";
import type { TimelineDoc } from "@/lib/timeline/types";

const TABS: readonly TabDef[] = [
  { id: "crop", label: "Crop", Icon: Crop },
  { id: "timeline", label: "Timeline", Icon: Scissors },
  { id: "captions", label: "Captions", Icon: Type },
  { id: "template", label: "Template", Icon: LayoutTemplate },
  { id: "export", label: "Export", Icon: Download },
];

/**
 * Whether a keyboard event should be left to the focused control rather than the
 * global shortcut handler: editable fields (typing) plus buttons / links / tabs,
 * which own Space/Enter/Arrow themselves — otherwise arrow-key tab navigation
 * would also scrub the player and Space on a button would double-fire.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  if (tag === "BUTTON" || tag === "A") return true;
  return target.getAttribute("role") === "tab";
}

/**
 * The two-pane clip editor (items 6 & 7). ONE shared `<video>` (owned here, in the
 * left pane) is composited with every overlay, and its playback events are routed
 * to whichever tab governs the clock — the Timeline tab drives segment-remapped
 * playback, every other tab loops the clip window `[in, out]`. The right pane is a
 * real tablist hosting each domain's controls. All domain state lives in the three
 * hooks (`useTimeline`/`useCaptions`/`useCrop`) so switching tabs never loses an
 * edit and the overlays never drift from the panels.
 *
 * The whole editor is one `region` named "Timeline editor" so the acceptance e2e
 * can reach the shared player, the strip, and the B-roll/CTA panels through it.
 */
export function EditorShell({
  clipId,
  projectId,
  projectName,
  title,
  range,
  inPoint,
  outPoint,
  srcWidth,
  srcHeight,
  referenceHeight,
  projectDuration,
  captionDoc,
  initialCrop,
  initialTimeline,
  templates,
  appliedTemplateId,
  templateCanUndo,
  durationSec,
  presetOverride,
  projectPreset,
  initialExports,
}: {
  clipId: number;
  projectId: number;
  projectName: string;
  title: string;
  range: string;
  inPoint: number;
  outPoint: number;
  srcWidth: number;
  srcHeight: number;
  referenceHeight: number | null;
  projectDuration: number | null;
  captionDoc: CaptionDoc;
  initialCrop: CropState | null;
  initialTimeline: TimelineDoc;
  templates: Template[];
  appliedTemplateId: number | null;
  templateCanUndo: boolean;
  durationSec: number;
  presetOverride: PlatformPresetId | null;
  projectPreset: PlatformPresetId | null;
  initialExports: ExportRow[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>("captions");
  const [previewMode, setPreviewMode] = useState<"source" | "export">(initialCrop ? "export" : "source");
  const [helpOpen, setHelpOpen] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [relTime, setRelTime] = useState(0);
  const [clipPlaying, setClipPlaying] = useState(false);

  const captions = useCaptions({ videoRef, clipId, inPoint, initialDoc: captionDoc });
  const crop = useCrop({ videoRef, clipId, srcWidth, srcHeight, initialCrop, relTime });
  const timeline = useTimeline({ videoRef, clipId, initialDoc: initialTimeline, captionDoc, snapEnabled });

  const timelineGoverns = activeTab === "timeline";

  // Pause the player when the governing tab changes so the two playback modes
  // (segment-remap vs clip-loop) never fight over the one element. Done in the
  // switch handler rather than an effect so no cascading render is triggered.
  const selectTab = useCallback(
    (tab: EditorTab) => {
      timeline.stop();
      setClipPlaying(false);
      setActiveTab(tab);
    },
    [timeline],
  );

  // --- shared player event routing -----------------------------------------
  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = inPoint;
    setRelTime(0);
    if (timelineGoverns) timeline.handleLoadedMetadata();
  }, [inPoint, timelineGoverns, timeline]);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setRelTime(clipRelativeTime(v.currentTime, inPoint));
    if (timelineGoverns) {
      timeline.handleTimeUpdate();
    } else if (v.currentTime >= outPoint || v.currentTime < inPoint - 0.25) {
      v.currentTime = inPoint;
    }
  }, [inPoint, outPoint, timelineGoverns, timeline]);

  const handlePlay = useCallback(() => {
    if (timelineGoverns) timeline.handlePlay();
    else setClipPlaying(true);
  }, [timelineGoverns, timeline]);

  const handlePause = useCallback(() => {
    if (timelineGoverns) timeline.handlePause();
    else setClipPlaying(false);
  }, [timelineGoverns, timeline]);

  const handleEnded = useCallback(() => {
    if (timelineGoverns) timeline.handleEnded();
  }, [timelineGoverns, timeline]);

  const togglePlay = useCallback(() => {
    if (timelineGoverns) {
      timeline.togglePlay();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, [timelineGoverns, timeline]);

  const playing = timelineGoverns ? timeline.playing : clipPlaying;

  // --- keyboard shortcuts (item 11) ----------------------------------------
  const seekBy = useCallback(
    (delta: number) => {
      if (timelineGoverns) {
        timeline.seekTimeline(Math.max(0, Math.min(timeline.total, timeline.playhead + delta)));
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.max(inPoint, Math.min(outPoint, v.currentTime + delta));
    },
    [timelineGoverns, timeline, inPoint, outPoint],
  );

  const jumpTo = useCallback(
    (edge: "in" | "out") => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = edge === "in" ? inPoint : Math.max(inPoint, outPoint - 0.05);
    },
    [inPoint, outPoint],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveKey(
        { key: event.key, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey, ctrl: event.ctrlKey },
        { activeTab, typing: isInteractiveTarget(event.target), helpOpen },
      );
      if (!action) return;
      event.preventDefault();
      switch (action.type) {
        case "toggle-play":
          togglePlay();
          break;
        case "seek":
          seekBy(action.delta);
          break;
        case "split":
          timeline.doSplit();
          break;
        case "delete":
          timeline.doDelete();
          break;
        case "undo":
          timeline.undo();
          break;
        case "redo":
          timeline.redo();
          break;
        case "set-in":
          timeline.trimSelectedToPlayhead("in");
          break;
        case "set-out":
          timeline.trimSelectedToPlayhead("out");
          break;
        case "jump-in":
          jumpTo("in");
          break;
        case "jump-out":
          jumpTo("out");
          break;
        case "toggle-help":
          setHelpOpen((o) => !o);
          break;
        case "close-help":
          setHelpOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, helpOpen, togglePlay, seekBy, jumpTo, timeline]);

  // --- player-stage props --------------------------------------------------
  // The crop overlay is always drawn in SOURCE framing so a reframe drag has the
  // whole frame; Export framing previews the result on the non-crop tabs.
  const cropTabActive = activeTab === "crop";
  const effectivePreviewMode = cropTabActive ? "source" : previewMode;
  const cue = activeCue(captions.doc, relTime);

  const targetAspect = useMemo(
    () => aspectRatioValue(resolvePresetSelection(presetOverride, projectPreset).preset.aspectRatio),
    [presetOverride, projectPreset],
  );

  const exportPreview: ExportPreview | null =
    effectivePreviewMode === "export"
      ? {
          targetAspect,
          cropRect: crop.hasCropForSelected ? crop.windowPx : null,
          srcWidth: crop.srcSpace.w,
          srcHeight: crop.srcSpace.h,
        }
      : null;

  return (
    <section
      role="region"
      aria-label="Timeline editor"
      className="flex flex-1 justify-center bg-surface px-4 py-8 font-sans sm:px-6 lg:py-12"
    >
      <main className="flex w-full max-w-3xl flex-col gap-6 lg:max-w-7xl">
        <header className="flex flex-col gap-1.5">
          <Link
            href={`/projects/${projectId}`}
            className="w-fit rounded text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ← {projectName}
          </Link>
          <div className="flex items-center gap-2">
            <Clapperboard className="h-5 w-5 text-accent" aria-hidden />
            <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
          </div>
          <p className="font-mono text-sm tabular-nums text-text-muted">{range}</p>
        </header>

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-start lg:gap-8">
          {/* LEFT PANE — the shared player, transport, and timeline strip */}
          <div className="flex flex-col gap-4 lg:sticky lg:top-6">
            <PlayerStage
              videoRef={videoRef}
              projectId={projectId}
              referenceHeight={referenceHeight}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onPlay={handlePlay}
              onPause={handlePause}
              onEnded={handleEnded}
              captionStyle={captions.doc.style}
              captionCue={cue}
              relTime={relTime}
              showCaption={!crop.dragging}
              cropOverlay={
                cropTabActive && crop.overlay
                  ? {
                      rect: crop.overlay,
                      ariaLabel: `${crop.selectedAR} crop window — drag to reposition`,
                      onPointerDown: crop.onPointerDown,
                      onPointerMove: crop.onPointerMove,
                      onPointerUp: crop.onPointerUp,
                    }
                  : null
              }
              previewDoc={timeline.doc}
              previewPlayhead={timeline.playhead}
              previewPlaying={timeline.playing}
              previewMode={effectivePreviewMode}
              exportPreview={exportPreview}
            />

            <div className="flex items-center justify-between gap-2">
              <TransportBar
                playing={playing}
                canDelete={!!timeline.selectedId && timeline.doc.segments.length > 1}
                canUndo={timeline.canUndo}
                canRedo={timeline.canRedo}
                snapEnabled={snapEnabled}
                onTogglePlay={togglePlay}
                onSplit={timeline.doSplit}
                onDelete={timeline.doDelete}
                onUndo={timeline.undo}
                onRedo={timeline.redo}
                onZoomOut={() => timeline.zoom(-1)}
                onZoomIn={() => timeline.zoom(1)}
                onFit={timeline.fitToWidth}
                onToggleSnap={() => setSnapEnabled((s) => !s)}
                onShowHelp={() => setHelpOpen(true)}
              />
              <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted" aria-live="polite">
                {timeline.saving ? "Saving…" : range}
              </span>
            </div>

            <TimelineStrip
              stripRef={timeline.stripRef}
              stripWidth={timeline.stripWidth}
              boxes={timeline.boxes}
              captionCues={timeline.captionCues}
              pxPerSec={timeline.pxPerSec}
              playhead={timeline.playhead}
              total={timeline.total}
              selectedId={timeline.selectedId}
              snapGuideX={timeline.snapGuideX}
              projectId={projectId}
              inPoint={inPoint}
              outPoint={outPoint}
              durationSec={projectDuration}
              onRulerClick={timeline.onRulerClick}
              onPointerMove={timeline.onPointerMove}
              onPointerUp={timeline.onPointerUp}
              onSelect={timeline.setSelectedId}
              onReorderStart={timeline.beginReorder}
              onTrimStart={timeline.beginTrim}
            />
            {timeline.error ? <p className="text-sm text-danger">{timeline.error}</p> : null}
          </div>

          {/* RIGHT PANE — the tabbed domain controls */}
          <div className="mt-6 flex flex-col gap-4 lg:mt-0">
            <EditorTabs tabs={TABS} active={activeTab} onSelect={selectTab} />
            <div id={`editor-panel-${activeTab}`} role="tabpanel" aria-labelledby={`editor-tab-${activeTab}`}>
              {activeTab === "crop" ? (
                <CropTab crop={crop} previewMode={previewMode} onPreviewMode={setPreviewMode} />
              ) : null}
              {activeTab === "timeline" ? <TimelineTab timeline={timeline} projectId={projectId} /> : null}
              {activeTab === "captions" ? <CaptionsTab captions={captions} relTime={relTime} /> : null}
              {activeTab === "template" ? (
                <TemplatePanel
                  clipId={clipId}
                  templates={templates}
                  appliedTemplateId={appliedTemplateId}
                  canUndo={templateCanUndo}
                  durationSec={durationSec}
                  presetOverride={presetOverride}
                  projectPreset={projectPreset}
                />
              ) : null}
              {activeTab === "export" ? (
                <ExportPanel
                  clipId={clipId}
                  projectId={projectId}
                  durationSec={durationSec}
                  hasCaptions={captions.doc.cues.length > 0}
                  presetOverride={presetOverride}
                  projectPreset={projectPreset}
                  initialExports={initialExports}
                />
              ) : null}
            </div>
          </div>
        </div>
      </main>

      {helpOpen ? <ShortcutsOverlay onClose={() => setHelpOpen(false)} /> : null}
    </section>
  );
}
