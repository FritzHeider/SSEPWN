"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AssetKind } from "@/lib/assets/kind";
import {
  assetInputAccept,
  assetLabel,
  assetMeta,
  assetThumbnailUrl,
  assetsListUrl,
  acceptedExtensions,
  hasUnprobedThumbnails,
  kindLabel,
  parseAssetsResponse,
  validatePickedFile,
  type PickerAsset,
} from "@/lib/assets/picker";

/** How long, and how many times, to re-poll after an upload for the worker's poster. */
const POLL_TRIES = 8;
const POLL_INTERVAL_MS = 1500;

/**
 * Reusable asset picker (Phase 08): browse the shared asset library for one
 * kind, upload a new asset, and select one. B-roll / SFX / CTA editors all
 * mount this with their kind and an `onSelect` callback.
 *
 * Server truth, thin client: the list comes from `GET /api/assets?kind=`, an
 * upload POSTs to `/api/assets` (scoped to `projectId` so the worker probes and
 * thumbnails it), and every decision — labels, the `accept` filter, whether a
 * picked file is plausible, whether to keep polling for posters — comes from the
 * pure `lib/assets/picker` helpers, unit-tested apart from this JSX (DEC-005).
 */
export function AssetPicker({
  projectId,
  kind,
  selectedId = null,
  onSelect,
}: {
  projectId: number;
  kind: AssetKind;
  selectedId?: number | null;
  onSelect: (asset: PickerAsset) => void;
}) {
  const [assets, setAssets] = useState<PickerAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<PickerAsset[]> => {
    try {
      const response = await fetch(assetsListUrl(kind));
      if (!response.ok) {
        if (alive.current) setError(`Could not load assets (${response.status})`);
        return [];
      }
      const list = parseAssetsResponse(await response.json().catch(() => null));
      if (alive.current) {
        setAssets(list);
        setError(null);
      }
      return list;
    } catch {
      if (alive.current) setError("Could not load assets — is the server running?");
      return [];
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [kind]);

  // Deferred (not a bare call in the effect body) so the async setState in
  // refresh never lands synchronously inside the effect — the same shape the
  // project list's polling uses.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // After an upload the probe worker fills the poster asynchronously; poll a
  // bounded number of times so it appears without a manual refresh, then stop
  // once every poster has landed or the budget runs out (a stalled/absent
  // worker must not poll forever).
  const pollForThumbnails = useCallback(() => {
    let tries = POLL_TRIES;
    const timer = window.setInterval(() => {
      if (!alive.current || tries <= 0) {
        window.clearInterval(timer);
        return;
      }
      tries -= 1;
      void refresh().then((list) => {
        if (!hasUnprobedThumbnails(list)) window.clearInterval(timer);
      });
    }, POLL_INTERVAL_MS);
  }, [refresh]);

  const upload = useCallback(
    async (file: File) => {
      const problem = validatePickedFile(file, kind);
      if (problem) {
        setError(problem);
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("projectId", String(projectId));
        const response = await fetch("/api/assets", { method: "POST", body: form });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          if (alive.current) setError(body?.error ?? `Upload failed (${response.status})`);
          return;
        }
        const created = (await response.json().catch(() => null)) as { asset?: unknown } | null;
        const list = await refresh();
        // Auto-select the freshly uploaded asset so the caller gets it immediately.
        const createdAsset = (created?.asset ?? null) as { id?: unknown } | null;
        const newId = typeof createdAsset?.id === "number" ? createdAsset.id : null;
        const picked = newId !== null ? list.find((a) => a.id === newId) : undefined;
        if (picked) onSelect(picked);
        pollForThumbnails();
      } catch {
        if (alive.current) setError("Upload failed — is the server still running?");
      } finally {
        if (alive.current) setUploading(false);
      }
    },
    [kind, projectId, refresh, onSelect, pollForThumbnails],
  );

  return (
    <div className="flex flex-col gap-3" data-testid="asset-picker" data-kind={kind}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{kindLabel(kind)} library</p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="rounded-md border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:border-zinc-400 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
        >
          {uploading ? "Uploading…" : `Upload ${kind}`}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={assetInputAccept(kind)}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No {kind} assets yet — upload one ({acceptedExtensions(kind).join(", ")}).
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {assets.map((asset) => {
            const poster = assetThumbnailUrl(asset);
            const meta = assetMeta(asset);
            const isSelected = asset.id === selectedId;
            return (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={() => onSelect(asset)}
                  data-testid="asset-option"
                  data-asset-id={asset.id}
                  aria-pressed={isSelected}
                  className={`flex w-full flex-col gap-1 rounded-lg border p-2 text-left transition-colors ${
                    isSelected
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                      : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                  }`}
                >
                  <span className="flex aspect-video items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                    {poster ? (
                      // eslint-disable-next-line @next/next/no-img-element -- data/ posters aren't statically served; a plain img avoids next/image loader config.
                      <img src={poster} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xs uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        {asset.kind ?? "asset"}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                    {assetLabel(asset)}
                  </span>
                  {meta ? (
                    <span className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                      {meta}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
