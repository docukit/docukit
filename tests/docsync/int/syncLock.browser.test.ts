import { expect, test } from "vitest";
import { pauseNextWrite } from "./syncTestUtils.js";
import { testWrapper } from "./utils.js";

test("tabs read pending batches only after the previous sync has persisted", async () => {
  await testWrapper(async ({ docId, reference, otherTab }) => {
    await reference.loadDoc();
    await otherTab.loadDoc();
    await reference.client["_sync"](docId);
    await otherTab.client["_sync"](docId);
    await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
    await expect.poll(() => otherTab.client["_syncQueue"].size).toBe(0);
    reference.disconnect();
    otherTab.disconnect();
    reference.addChild("A");
    reference.doc?.forceCommit();
    await reference.client["_flushLocalOperations"](docId, { sync: false });

    const { provider, identity } = await reference.client["_localPromise"];
    const paused = pauseNextWrite(provider);
    try {
      reference.connect();
      await paused.writing;
      const before = otherTab.reqSpy.mock.calls.filter(
        ([event]) => event === "sync",
      ).length;
      otherTab.connect();
      const name = `docsync:sync:${JSON.stringify([identity.userId, docId])}`;
      await expect
        .poll(async () =>
          (await navigator.locks.query()).pending?.some(
            (lock) => lock.name === name,
          ),
        )
        .toBe(true);
      expect(
        otherTab.reqSpy.mock.calls.filter(([event]) => event === "sync"),
      ).toHaveLength(before);
      paused.resume();
      await reference.assertIDBDoc({ doc: ["A"], ops: [] });
      await expect
        .poll(
          () =>
            otherTab.reqSpy.mock.calls
              .filter(([event]) => event === "sync")
              .at(-1)?.[1].operations,
        )
        .toStrictEqual([]);
      reference.disconnect();
      otherTab.disconnect();
      reference.addChild("B");
      reference.doc?.forceCommit();
      await reference.client["_flushLocalOperations"](docId, { sync: false });
      await reference.assertIDBDoc({ doc: ["A"], ops: ["B"] });
    } finally {
      paused.resume();
      paused.restore();
    }
  });
});
