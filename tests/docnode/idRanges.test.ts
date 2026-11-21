import { describe, expect, test } from "vitest";

import { _INTERNAL_IdRanges as IdRanges } from "@docukit/docnode/crdt";

describe("id ranges", () => {
  const runs = (ranges: InstanceType<typeof IdRanges>) => {
    const out: Record<string, readonly number[]> = {};
    ranges.forEach((session, sessionRuns) => (out[session] = sessionRuns));
    return out;
  };

  test("merges adjacent runs with the same life", () => {
    const ranges = new IdRanges();
    ranges.add("s", 3, 5, 0);
    ranges.add("s", 6, 7, 0);
    ranges.add("s", 1, 2, 0);
    expect(runs(ranges)).toStrictEqual({ s: [1, 7, 0] });
    expect(ranges.get("s", 4)).toBe(0);
    expect(ranges.get("s", 9)).toBe(-1);
    expect(ranges.get("other", 1)).toBe(-1);
  });

  test("keeps the highest life on overlap and splits runs", () => {
    const ranges = new IdRanges();
    ranges.add("s", 1, 10, 0);
    ranges.add("s", 4, 5, 2);
    expect(ranges.get("s", 3)).toBe(0);
    expect(ranges.get("s", 4)).toBe(2);
    expect(ranges.get("s", 6)).toBe(0);
    ranges.add("s", 0, 11, 1);
    expect(ranges.get("s", 0)).toBe(1);
    expect(ranges.get("s", 4)).toBe(2);
    expect(ranges.get("s", 11)).toBe(1);
    ranges.add("s", 20, 22, 0);
    expect(ranges.get("s", 21)).toBe(0);
  });

  test("lists each session with its runs", () => {
    const ranges = new IdRanges();
    ranges.add("s", 1, 3, 1);
    ranges.add("t", 5, 5, 0);
    expect(runs(ranges)).toStrictEqual({ s: [1, 3, 1], t: [5, 5, 0] });
  });

  test("adds ids in order without searching", () => {
    const ranges = new IdRanges();
    expect(ranges.isEmpty()).toBe(true);
    ranges.add("s", 1, 1, 0);
    ranges.add("s", 2, 4, 0);
    ranges.add("s", 3, 6, 0);
    ranges.add("s", 8, 8, 0);
    ranges.add("s", 9, 9, 1);
    expect(runs(ranges)).toStrictEqual({ s: [1, 6, 0, 8, 8, 0, 9, 9, 1] });
    expect(ranges.isEmpty()).toBe(false);
  });
});
