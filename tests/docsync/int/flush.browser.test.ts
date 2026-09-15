import { expect, test, vi } from "vitest";
import { testWrapper } from "./utils.js";
import { pauseNextWrite } from "./syncTestUtils.js";

test("flush waits for a previous write even after it took the pending batch", async () => {
  await testWrapper(async ({ docId, reference }) => {
    await reference.loadDoc();
    await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
    reference.disconnect();
    const { provider } = await reference.client["_localPromise"];
    const paused = pauseNextWrite(provider);
    try {
      reference.addChild("pending");
      reference.doc?.forceCommit();
      const first = reference.client.flush(docId);
      await paused.writing;
      expect(reference.client["_localOpsBatchState"].has(docId)).toBe(false);
      const finished = vi.fn();
      const closing = reference.client.flush(docId).then(finished);
      // Give the second flush its microtask turn; the provider is still held.
      await Promise.resolve();
      await Promise.resolve();
      expect(finished).not.toHaveBeenCalled();
      paused.resume();
      await Promise.all([first, closing]);
      expect(finished).toHaveBeenCalledOnce();
      await reference.assertIDBDoc({ doc: [], ops: ["pending"] });
    } finally {
      paused.restore();
    }
  });
});
