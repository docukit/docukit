import { expect, test } from "vitest";
import { testWrapper } from "./utils.js";

const FIRST = "typed while both tabs were open";
const SECOND = "typed while the slow tab was still waiting";

/**
 * Two tabs of the same user share one IndexedDB. Both are open on the same
 * document and both sync it. Nothing here is contrived: one tab simply has a
 * slower connection than the other, which is the normal state of the web.
 */
test("a slow tab must not acknowledge a batch it never sent", async () => {
  await testWrapper(async ({ docId, reference, otherTab, otherDevice }) => {
    otherDevice.disconnect();
    await reference.loadDoc();
    await otherTab.loadDoc();
    await reference.client["_sync"](docId);
    await otherTab.client["_sync"](docId);
    await expect
      .poll(
        () =>
          reference.client["_syncQueue"].size +
          otherTab.client["_syncQueue"].size,
      )
      .toBe(0);
    // This test drives every sync itself, so keep the debounces out of the way.
    for (const peer of [reference, otherTab]) {
      peer.client["_singleClientMaxDebounce"] = 5000;
      peer.client["_collabMaxDebounce"] = 5000;
    }

    // The user types. The batch lands in the IndexedDB both tabs share.
    reference.addChild(FIRST);
    reference.doc?.forceCommit();
    await reference.client["_flushLocalOperations"](docId, { sync: false });

    const slowTab = otherTab.holdNextSyncRequest();
    try {
      // The second tab syncs: it reads the shared pending batch into a
      // request, but its uplink is slow and the request is still in the air.
      void otherTab.client["_sync"](docId);
      await slowTab.captured;

      // The first tab syncs normally and consolidates that same batch.
      await reference.client["_sync"](docId);
      await reference.assertIDBDoc({ doc: [FIRST], ops: [] });

      // The user keeps typing while the slow tab is still waiting. This edit
      // is in no request: it exists only in the shared pending queue.
      reference.addChild(SECOND);
      reference.doc?.forceCommit();
      await reference.client["_flushLocalOperations"](docId, { sync: false });
      await reference.assertIDBDoc({ doc: [FIRST], ops: [SECOND] });

      // The slow request finally goes out and the second tab reconciles.
      slowTab.release();
      await expect.poll(() => otherTab.client["_syncQueue"].size).toBe(0);
    } finally {
      slowTab.restore();
    }

    // Close both tabs offline and reopen from local storage. The second edit
    // may still be pending or may have been consolidated by a follow-up sync;
    // either way it must be there.
    reference.disconnect();
    otherTab.disconnect();
    reference.unLoadDoc();
    otherTab.unLoadDoc();
    await expect
      .poll(
        () =>
          reference.client["_docsCache"].size +
          otherTab.client["_docsCache"].size,
      )
      .toBe(0);
    await reference.loadDoc();
    await reference.assertMemoryDoc([FIRST, SECOND]);
  });
});
