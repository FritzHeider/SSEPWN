import { describe, expect, it } from "vitest";

import {
  reinsert,
  reinsertMany,
  removeById,
  removeManyByIds,
} from "../src/lib/projects/pending-delete";

interface Row {
  id: number;
  name: string;
}

const rows: Row[] = [
  { id: 1, name: "a" },
  { id: 2, name: "b" },
  { id: 3, name: "c" },
];

describe("removeById / reinsert", () => {
  it("removes a row and reports the index it held", () => {
    const { list, removed } = removeById(rows, 2);
    expect(list.map((r) => r.id)).toEqual([1, 3]);
    expect(removed).toEqual({ item: { id: 2, name: "b" }, index: 1 });
  });

  it("is a no-op for an id that is not present", () => {
    const { list, removed } = removeById(rows, 99);
    expect(list.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(removed).toBeNull();
  });

  it("restores a removed row to its original slot", () => {
    const { list, removed } = removeById(rows, 2);
    expect(reinsert(list, removed!).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("clamps the restore index when the list shrank underneath", () => {
    const removed = { item: { id: 9, name: "z" }, index: 5 };
    expect(reinsert([{ id: 1, name: "a" }], removed).map((r) => r.id)).toEqual([1, 9]);
  });
});

describe("removeManyByIds / reinsertMany", () => {
  it("removes a batch and records each original index", () => {
    const { list, removed } = removeManyByIds(rows, [1, 3]);
    expect(list.map((r) => r.id)).toEqual([2]);
    expect(removed.map((r) => r.index)).toEqual([0, 2]);
  });

  it("restores a batch to the exact original order", () => {
    const { list, removed } = removeManyByIds(rows, [1, 3]);
    expect(reinsertMany(list, removed).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("restores correctly even if removals are given high-index first", () => {
    const { list } = removeManyByIds(rows, [1, 2, 3]);
    const shuffled = [
      { item: { id: 3, name: "c" }, index: 2 },
      { item: { id: 1, name: "a" }, index: 0 },
      { item: { id: 2, name: "b" }, index: 1 },
    ];
    expect(reinsertMany(list, shuffled).map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
