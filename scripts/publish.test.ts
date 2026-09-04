import { describe, expect, test } from "vitest";
import { resolveReleaseTag, verifyPublishedSpecs } from "./publish-utils.ts";

describe("resolveReleaseTag", () => {
  test("reads the tag from a squash-merged release commit", () => {
    expect(
      resolveReleaseTag("chore: release v0.4.1-alpha.2 (#62)", [
        "0.4.1",
        "0.4.1-alpha.2",
      ]),
    ).toBe("v0.4.1-alpha.2");
  });

  test("rejects a tag that does not match a publishable package", () => {
    expect(() =>
      resolveReleaseTag("chore: release v0.4.2 (#63)", [
        "0.4.1",
        "0.4.1-alpha.2",
      ]),
    ).toThrow(
      "release tag v0.4.2 does not match a publishable package version",
    );
  });

  test("rejects a commit that is not a release", () => {
    expect(() =>
      resolveReleaseTag("fix: make publishing resilient", [
        "0.4.1",
        "0.4.1-alpha.2",
      ]),
    ).toThrow("cannot derive release tag from a 'chore: release v...' commit");
  });
});

describe("verifyPublishedSpecs", () => {
  test("checks packages in parallel while npm metadata becomes visible", async () => {
    const first = "@docukit/docsync@0.4.1-alpha.2";
    const second = "@docukit/docsync-react@0.4.1-alpha.2";
    const reads = new Map<string, number>();
    const trace: string[] = [];

    const failures = await verifyPublishedSpecs([first, second], {
      attempts: 3,
      delayMs: 0,
      readVersion: (spec) => {
        trace.push(spec);
        const count = (reads.get(spec) ?? 0) + 1;
        reads.set(spec, count);
        return count === 2 ? "0.4.1-alpha.2" : undefined;
      },
      wait: async () => Promise.resolve(),
    });

    expect(failures).toStrictEqual([]);
    expect(trace.slice(0, 2)).toStrictEqual([first, second]);
  });

  test("reports packages still missing after the retry window", async () => {
    const spec = "@docukit/docsync@0.4.1-alpha.2";

    const failures = await verifyPublishedSpecs([spec], {
      attempts: 2,
      delayMs: 0,
      readVersion: () => undefined,
      wait: async () => Promise.resolve(),
    });

    expect(failures).toStrictEqual([`${spec} (registry: not found)`]);
  });
});
