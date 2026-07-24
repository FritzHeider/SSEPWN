/**
 * Pure list bookkeeping for undoable deletes (item 22).
 *
 * Both the project list and the clips list delete optimistically: the row
 * vanishes at once, a toast offers Undo for a few seconds, and only when the
 * toast expires un-undone does the real DELETE fire. Undo must put the row back
 * exactly where it was — not at the end, which would silently re-rank a list
 * whose order carries meaning (clips are ranked best-first). That "remove, then
 * reinsert at the original index" math is the testable part and lives here;
 * the component owns the timers and the network.
 */

/** An item plucked out of a list, with the index it held so Undo can restore it. */
export interface Removed<T> {
  item: T;
  index: number;
}

/**
 * Remove the item with `id`, returning the shortened list and what came out.
 * `index` is -1 and `item` null when nothing matched, so a stale double-click
 * is a no-op rather than a throw.
 */
export function removeById<T extends { id: number }>(
  list: readonly T[],
  id: number,
): { list: T[]; removed: Removed<T> | null } {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return { list: [...list], removed: null };
  const next = list.slice();
  const [item] = next.splice(index, 1);
  return { list: next, removed: { item, index } };
}

/**
 * Put a removed item back at the index it held. The index is clamped to the
 * current length, so restoring into a list that changed underneath (another row
 * arrived via SSE while the toast was up) lands it as close to home as possible
 * rather than throwing or dropping it.
 */
export function reinsert<T>(list: readonly T[], removed: Removed<T>): T[] {
  const at = Math.max(0, Math.min(removed.index, list.length));
  const next = list.slice();
  next.splice(at, 0, removed.item);
  return next;
}

/**
 * Remove several items at once (batch delete), returning the shortened list and
 * every removal with its original index. Removals are reported in ascending
 * index order so `reinsertMany` can replay them low-to-high and each index still
 * refers to the right slot.
 */
export function removeManyByIds<T extends { id: number }>(
  list: readonly T[],
  ids: readonly number[],
): { list: T[]; removed: Removed<T>[] } {
  const idSet = new Set(ids);
  const removed: Removed<T>[] = [];
  const kept: T[] = [];
  list.forEach((item, index) => {
    if (idSet.has(item.id)) removed.push({ item, index });
    else kept.push(item);
  });
  return { list: kept, removed };
}

/** Restore a batch of removed items to their original indices (Undo for a bulk
 * delete). Replays low-index-first so earlier reinserts do not shift the slots
 * later ones target. */
export function reinsertMany<T>(list: readonly T[], removed: readonly Removed<T>[]): T[] {
  const ordered = [...removed].sort((a, b) => a.index - b.index);
  let next: T[] = list.slice();
  for (const entry of ordered) {
    next = reinsert(next, entry);
  }
  return next;
}
