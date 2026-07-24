"use client";

import { SeparatorVertical } from "lucide-react";

import { StylePanel } from "./style-panel";
import type { CaptionsController } from "./use-captions";
import { activeWordIndex } from "@/lib/captions/preview";
import { formatDuration } from "@/lib/projects/view";

/**
 * The Captions tab (right pane): the style panel plus the caption list synced to
 * the shared player's clock (`relTime`). The list addresses lines by the flat
 * index the edit API uses; clicking a word edits it, the "|" split control is now
 * a labelled {@link SeparatorVertical} icon with a ≥28 px hit area, and the
 * word-edit input sizes to its content (item 10 a11y pass). The document itself
 * lives in the shared {@link CaptionsController} so the overlay on the player and
 * this list never drift.
 */
export function CaptionsTab({
  captions,
  relTime,
}: {
  captions: CaptionsController;
  relTime: number;
}) {
  const { doc, lines, busy, editing, draft, setDraft, setEditing, patch, seekToLine, beginEdit, commitEdit, onStyle } =
    captions;
  const activeLine = captions.activeLine(relTime);
  const style = doc.style;

  return (
    <div className="flex flex-col gap-6">
      <StylePanel style={style} activePreset={doc.name} disabled={busy} onStyle={onStyle} />

      {captions.error ? (
        <p className="text-sm text-danger">{captions.error}</p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Captions</h2>

        {lines.length === 0 ? (
          <p className="rounded-lg border border-border-subtle p-6 text-sm text-text-muted">
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
                    ? "border-accent bg-accent/10"
                    : "border-border-subtle"
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => seekToLine(line.start)}
                    className="cursor-pointer rounded px-1.5 py-1 font-mono tabular-nums text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {formatDuration(line.start)}
                  </button>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => patch({ op: "shift-line", line: index, delta: -0.1 })}
                      className="cursor-pointer rounded px-2 py-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label={`Shift line ${index + 1} earlier`}
                    >
                      −0.1s
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => patch({ op: "shift-line", line: index, delta: 0.1 })}
                      className="cursor-pointer rounded px-2 py-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label={`Shift line ${index + 1} later`}
                    >
                      +0.1s
                    </button>
                    <button
                      type="button"
                      disabled={busy || index >= lines.length - 1}
                      onClick={() => patch({ op: "merge-line", line: index })}
                      className="cursor-pointer rounded px-2 py-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      Merge ↓
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1.5 text-sm">
                  {line.words.map((w, wi) => (
                    <span key={wi} className="flex items-center">
                      {wi > 0 ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => patch({ op: "split-line", line: index, word: wi })}
                          aria-label={`Split line ${index + 1} before "${w.text}"`}
                          title="Split line here"
                          className="flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded p-1 text-text-muted transition-colors hover:text-accent hover:bg-surface-overlay disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <SeparatorVertical className="h-4 w-4" aria-hidden />
                        </button>
                      ) : null}
                      {editing && editing.line === index && editing.word === wi ? (
                        <input
                          autoFocus
                          data-testid="caption-word-input"
                          aria-label="Edit word"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditing(null);
                          }}
                          style={{ width: `${Math.max(4, draft.length + 1)}ch` }}
                          className="rounded border border-accent bg-surface-raised px-1.5 py-1 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        />
                      ) : (
                        <button
                          type="button"
                          data-testid="caption-word"
                          data-line={index}
                          data-word={wi}
                          onClick={() => beginEdit(index, wi, w.text)}
                          className={`min-h-7 cursor-pointer rounded px-2 py-1 transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                            index === activeLine && activeWordIndex(line, relTime) === wi
                              ? "font-semibold text-accent"
                              : "text-text"
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
