import { expect, test } from "vitest";
import { holdNextWrite } from "./unloadUtils.js";
import { testWrapper } from "./utils.js";

test("overlapping acknowledgements preserve an edit absent from both requests after reopening", async () => {
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
    for (const peer of [reference, otherTab]) {
      peer.client["_singleClientMaxDebounce"] = 5000;
      peer.client["_collabMaxDebounce"] = 5000;
      peer.disconnect();
    }
    reference.addChild("first edit");
    reference.doc?.forceCommit();
    await reference.client["_flushLocalOperations"](docId, { sync: false });
    const firstLocal = await reference.client["_localPromise"];
    const secondLocal = await otherTab.client["_localPromise"];
    const first = holdNextWrite(firstLocal.provider);
    const second = holdNextWrite(secondLocal.provider);
    let secondIsWriting = false;
    void second.writing.then(() => {
      secondIsWriting = true;
    });
    try {
      reference.connect();
      await first.writing;
      otherTab.connect();
      const name = `docsync:sync:${JSON.stringify([firstLocal.identity.userId, docId])}`;
      // Without the lock, both responses can arrive before either is saved.
      // Allow that ordering so removing the lock fails on lost content,
      // rather than on an assertion that the implementation uses a lock.
      await expect
        .poll(
          async () =>
            secondIsWriting ||
            (await navigator.locks.query()).pending?.some(
              (lock) => lock.name === name,
            ),
        )
        .toBe(true);
      first.resume();
      await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
      reference.disconnect();
      await second.writing;
      reference.addChild("new edit");
      reference.doc?.forceCommit();
      await reference.client["_flushLocalOperations"](docId, { sync: false });
      await reference.assertIDBDoc({ doc: ["first edit"], ops: ["new edit"] });
      second.resume();
      await expect.poll(() => otherTab.client["_syncQueue"].size).toBe(0);
      otherTab.disconnect();

      // Drop both live instances: the edit must survive in durable storage.
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
      await reference.assertMemoryDoc(["first edit", "new edit"]);
      reference.connect();
      await reference.client["_sync"](docId);
      await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
      otherDevice.connect();
      await otherDevice.loadDoc();
      await otherDevice.assertMemoryDoc(["first edit", "new edit"]);
    } finally {
      first.restore();
      second.restore();
      reference.disconnect();
      otherTab.disconnect();
    }
  });
});
