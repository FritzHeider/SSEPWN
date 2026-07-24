"use client";

import { Check, Pencil, Play, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { ProjectClip } from "@/lib/projects/clips";
import { clipDurationLabel, clipRangeLabel, clipScoreLabel, clipTitle } from "@/lib/projects/clips-panel";
import { scoreBarColor, scoreBarWidth, scoreFraction } from "@/lib/projects/score-bar";

/**
 * One ranked clip card (items 13-UI, 15, 18, 28, 30-UI): a 16:9 poster, an
 * inline-renameable title, a normalized score bar with the reasons as its
 * tooltip and clickable chips that link into the transcript, a batch-select
 * checkbox, and preview / captions / delete actions.
 */
export function ClipCard({
  clip,
  rank,
  maxScore,
  thumbVersion,
  selected,
  onToggleSelect,
  onPreview,
  onRename,
  onDelete,
  onReasonClick,
  disabled,
}: {
  clip: ProjectClip;
  rank: number;
  maxScore: number;
  /** Bumps when a clip-thumbnail job finishes, to retry a previously-404 poster. */
  thumbVersion: number;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  onPreview: (inPoint: number, outPoint: number) => void;
  onRename: (id: number, title: string) => Promise<boolean>;
  onDelete: (clip: ProjectClip) => void;
  onReasonClick: (clip: ProjectClip) => void;
  disabled: boolean;
}) {
  const fraction = scoreFraction(clip.score, maxScore);
  const scoreLabel = clipScoreLabel(clip);

  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3">
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(clip.id)}
        aria-label={`Select ${clipTitle(clip)}`}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
      />

      <Thumb clip={clip} thumbVersion={thumbVersion} onPreview={() => onPreview(clip.inPoint, clip.outPoint)} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <TitleRow clip={clip} rank={rank} onRename={onRename} />

        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          {fraction === null ? (
            <span className="rounded bg-[var(--surface-overlay)] px-1.5 py-0.5 font-mono tabular-nums">
              {scoreLabel === null ? "Manual" : `score ${scoreLabel}`}
            </span>
          ) : (
            <span
              className="flex items-center gap-1.5"
              title={clip.reasons.length > 0 ? `Why this clip: ${clip.reasons.join(", ")}` : undefined}
            >
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-overlay)]">
                <span
                  className="block h-full rounded-full"
                  style={{ width: scoreBarWidth(fraction), background: scoreBarColor(fraction) }}
                />
              </span>
              <span className="font-mono tabular-nums">{scoreLabel}</span>
            </span>
          )}
          <span className="font-mono tabular-nums">{clipDurationLabel(clip)}</span>
          <span className="font-mono tabular-nums">{clipRangeLabel(clip)}</span>
        </div>

        {clip.reasons.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {clip.reasons.map((reason, r) => (
              <button
                key={r}
                type="button"
                onClick={() => onReasonClick(clip)}
                title="Jump to this moment in the transcript"
                className="rounded bg-[color-mix(in_oklab,var(--timeline)_16%,transparent)] px-1.5 py-0.5 text-xs text-[var(--timeline)] transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {reason}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <Link
        href={`/clips/${clip.id}`}
        aria-label={`Edit captions for ${clipTitle(clip)}`}
        className="flex h-11 shrink-0 items-center rounded-md px-2 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-overlay)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Captions
      </Link>
      <button
        type="button"
        onClick={() => onDelete(clip)}
        disabled={disabled}
        aria-label={`Delete ${clipTitle(clip)}`}
        className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function TitleRow({
  clip,
  rank,
  onRename,
}: {
  clip: ProjectClip;
  rank: number;
  onRename: (id: number, title: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const start = () => {
    setDraft(clipTitle(clip));
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    if (next.length === 0 || next === clipTitle(clip)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onRename(clip.id, next);
    setSaving(false);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={draft}
          disabled={saving}
          maxLength={120}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            else if (event.key === "Escape") setEditing(false);
          }}
          aria-label="Clip title"
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => void commit()}
          disabled={saving}
          aria-label="Save title"
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--success)] hover:bg-[var(--surface-overlay)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Check className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          aria-label="Cancel rename"
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-overlay)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">#{rank}</span>
      <span className="min-w-0 truncate text-sm font-medium text-[var(--text)]">{clipTitle(clip)}</span>
      <button
        type="button"
        onClick={start}
        aria-label={`Rename ${clipTitle(clip)}`}
        className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

function Thumb({
  clip,
  thumbVersion,
  onPreview,
}: {
  clip: ProjectClip;
  thumbVersion: number;
  onPreview: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const [prevVersion, setPrevVersion] = useState(thumbVersion);

  // A newly-generated poster (SSE clip-thumbnail done) bumps thumbVersion; clear
  // the 404 fallback and retry. Adjusting state during render is React's pattern
  // for "reset a value when a prop changes" (see worker-status.tsx).
  if (thumbVersion !== prevVersion) {
    setPrevVersion(thumbVersion);
    setBroken(false);
  }

  return (
    <button
      type="button"
      onClick={onPreview}
      aria-label={`Preview ${clipTitle(clip)}`}
      className="group relative aspect-video h-12 shrink-0 overflow-hidden rounded bg-[var(--surface-overlay)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      {!broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={thumbVersion}
          src={`/api/clips/${clip.id}/thumbnail?v=${thumbVersion}`}
          alt=""
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : null}
      <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
        <Play className="h-4 w-4 text-white" aria-hidden />
      </span>
    </button>
  );
}
