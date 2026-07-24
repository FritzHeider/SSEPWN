"use client";

import { useCallback, useEffect, useRef } from "react";

import type { ToastOptions } from "@/app/_components/toaster";
import { reinsertMany, removeManyByIds, type Removed } from "@/lib/projects/pending-delete";

/** How long a delete can be undone before it actually fires. */
const UNDO_MS = 5000;

interface Batch<T> {
  timeout: ReturnType<typeof setTimeout>;
  removed: Removed<T>[];
}

/**
 * Optimistic, undoable deletes for a list (item 22), single row or whole batch.
 *
 * A delete removes the row(s) at once and shows a toast with Undo; the real
 * DELETE fires only when the toast expires un-undone. Undo restores every row to
 * its original index (no refetch) via the pure `pending-delete` helpers. Leaving
 * the page — unload or SPA unmount — flushes any pending deletes with a
 * `keepalive` DELETE so nothing is silently kept. A failed commit re-inserts the
 * rows and raises a danger toast.
 *
 * `getPendingIds` lets a live refetch (SSE) drop rows whose delete is mid-undo,
 * so the server's still-present copy does not resurrect them.
 */
export function useUndoableDelete<T extends { id: number }>({
  setList,
  deleteUrl,
  toast,
}: {
  setList: (updater: (current: T[]) => T[]) => void;
  deleteUrl: (id: number) => string;
  toast: (options: ToastOptions) => void;
}) {
  const pending = useRef(new Map<number, Batch<T>>());
  const nextBatch = useRef(0);

  // `deleteUrl` is typically an inline function (new identity every render).
  // Keep it in a ref so the flush effect below can have `[]` deps — otherwise its
  // cleanup would run on every render and flush pending deletes immediately,
  // firing the DELETE within milliseconds and killing the undo window.
  const deleteUrlRef = useRef(deleteUrl);
  useEffect(() => {
    deleteUrlRef.current = deleteUrl;
  }, [deleteUrl]);

  const commit = useCallback(
    async (batchId: number) => {
      const batch = pending.current.get(batchId);
      if (!batch) return;
      pending.current.delete(batchId);
      const results = await Promise.all(
        batch.removed.map(async (entry) => {
          try {
            const res = await fetch(deleteUrlRef.current(entry.item.id), { method: "DELETE" });
            return res.ok;
          } catch {
            return false;
          }
        }),
      );
      const failed = batch.removed.filter((_, i) => !results[i]);
      if (failed.length > 0) {
        setList((current) => reinsertMany(current, failed));
        toast({
          title: `Could not delete ${failed.length === 1 ? "1 item" : `${failed.length} items`}`,
          description: "They were restored.",
          variant: "danger",
        });
      }
    },
    [setList, toast],
  );

  const undo = useCallback(
    (batchId: number) => {
      const batch = pending.current.get(batchId);
      if (!batch) return;
      clearTimeout(batch.timeout);
      pending.current.delete(batchId);
      setList((current) => reinsertMany(current, batch.removed));
    },
    [setList],
  );

  const removeMany = useCallback(
    (list: T[], items: readonly T[], toastOptions: Omit<ToastOptions, "action" | "durationMs">) => {
      const ids = items.map((item) => item.id);
      const { list: next, removed } = removeManyByIds(list, ids);
      if (removed.length === 0) return;
      setList(() => next);
      const batchId = nextBatch.current++;
      const timeout = setTimeout(() => void commit(batchId), UNDO_MS);
      pending.current.set(batchId, { timeout, removed });
      toast({
        ...toastOptions,
        durationMs: UNDO_MS,
        action: { label: "Undo", onClick: () => undo(batchId) },
      });
    },
    [commit, undo, setList, toast],
  );

  const removeOne = useCallback(
    (list: T[], item: T, toastOptions: Omit<ToastOptions, "action" | "durationMs">) => {
      removeMany(list, [item], toastOptions);
    },
    [removeMany],
  );

  const getPendingIds = useCallback((): Set<number> => {
    const ids = new Set<number>();
    for (const batch of pending.current.values()) {
      for (const entry of batch.removed) ids.add(entry.item.id);
    }
    return ids;
  }, []);

  // Commit any pending deletes on leave (unload or unmount) so navigating away
  // still deletes; keepalive lets the request outlive the page. `[]` deps so this
  // only tears down on real unmount — not on every render (see `deleteUrlRef`).
  useEffect(() => {
    const map = pending.current;
    const flush = () => {
      for (const [, batch] of map) {
        clearTimeout(batch.timeout);
        for (const entry of batch.removed) {
          void fetch(deleteUrlRef.current(entry.item.id), { method: "DELETE", keepalive: true });
        }
      }
      map.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return { removeOne, removeMany, getPendingIds };
}
