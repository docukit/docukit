import { expect, test, vi } from "vitest";
import { holdNextWrite, withClosingDocument } from "./unloadUtils.js";

test("closing sends an edit before disposing instead of canceling its debounce", async () => {
  await withClosingDocument(async ({ docId, reference, otherDevice }) => {
    reference.addChild("closed before debounce");
    reference.unLoadDoc();
    await expect
      .poll(() => reference.client["_docsCache"].has(docId))
      .toBe(false);
    await reference.assertIDBDoc({ doc: ["closed before debounce"], ops: [] });
    otherDevice.connect();
    await otherDevice.loadDoc();
    await otherDevice.assertMemoryDoc(["closed before debounce"]);
  });
});

test("offline closing keeps the instance until its edit reaches IndexedDB", async () => {
  await withClosingDocument(async ({ docId, reference }) => {
    reference.disconnect();
    const { provider } = await reference.client["_localPromise"];
    const held = holdNextWrite(provider);
    const doc = reference.doc;
    try {
      reference.addChild("offline edit");
      reference.unLoadDoc();
      await held.writing;
      expect(await reference.client["_docsCache"].get(docId)?.promisedDoc).toBe(
        doc,
      );
      held.resume();
      await expect
        .poll(() => reference.client["_docsCache"].has(docId))
        .toBe(false);
      await reference.assertIDBDoc({ doc: [], ops: ["offline edit"] });
    } finally {
      held.restore();
    }
  });
});

test("closing also waits for a write that already took the pending batch", async () => {
  await withClosingDocument(async ({ docId, reference }) => {
    reference.disconnect();
    const { provider } = await reference.client["_localPromise"];
    const held = holdNextWrite(provider);
    try {
      reference.addChild("in-flight write");
      reference.doc?.forceCommit();
      const saving = reference.client["_flushLocalOperations"](docId, {
        sync: false,
      });
      await held.writing;
      const closing = reference.client["_unloadDoc"](docId);
      await Promise.resolve();
      expect(reference.client["_docsCache"].has(docId)).toBe(true);
      held.resume();
      await Promise.all([saving, closing]);
      expect(reference.client["_docsCache"].has(docId)).toBe(false);
      await reference.assertIDBDoc({ doc: [], ops: ["in-flight write"] });
    } finally {
      held.restore();
    }
  });
});

test("reopening during the save reuses the live instance and prevents its disposal", async () => {
  await withClosingDocument(async ({ docId, reference }) => {
    reference.disconnect();
    const { provider } = await reference.client["_localPromise"];
    const held = holdNextWrite(provider);
    const doc = reference.doc;
    try {
      reference.addChild("still here");
      reference.unLoadDoc();
      await held.writing;
      await reference.loadDoc();
      expect(reference.doc).toBe(doc);
      await reference.assertMemoryDoc(["still here"]);
      held.resume();
      await reference.assertIDBDoc({ doc: [], ops: ["still here"] });
      expect(reference.client["_docsCache"].get(docId)?.refCount).toBe(1);
      reference.addChild("after reopening");
      reference.unLoadDoc();
      await expect
        .poll(() => reference.client["_docsCache"].has(docId))
        .toBe(false);
      await reference.assertIDBDoc({
        doc: [],
        ops: ["still here", "after reopening"],
      });
    } finally {
      held.restore();
    }
  });
});

test("closing during a sync waits for the follow-up carrying newer edits", async () => {
  await withClosingDocument(async ({ docId, reference, otherDevice }) => {
    let closed = false;
    reference.client.on("sync", ({ req }) => {
      if (closed || req.docId !== docId || req.operations.length === 0) return;
      closed = true;
      reference.addChild("during sync");
      reference.unLoadDoc();
    });
    reference.addChild("first edit");
    reference.doc?.forceCommit();
    await reference.client["_sync"](docId);
    expect(closed).toBe(true);
    await expect
      .poll(() => reference.client["_docsCache"].has(docId))
      .toBe(false);
    otherDevice.connect();
    await otherDevice.loadDoc();
    await otherDevice.assertMemoryDoc(["first edit", "during sync"]);
    await reference.assertIDBDoc({
      doc: ["first edit", "during sync"],
      ops: [],
    });
  });
});

test("close, reopen and close during one write only disposes the latest close", async () => {
  await withClosingDocument(async ({ docId, reference }) => {
    reference.disconnect();
    const { provider } = await reference.client["_localPromise"];
    const held = holdNextWrite(provider);
    const dispose = vi.spyOn(reference.client["_docBinding"], "dispose");
    try {
      reference.addChild("first close");
      reference.unLoadDoc();
      await held.writing;
      await reference.loadDoc();
      reference.addChild("second close");
      reference.unLoadDoc();
      held.resume();
      await expect
        .poll(() => reference.client["_docsCache"].has(docId))
        .toBe(false);
      await reference.assertIDBDoc({
        doc: [],
        ops: ["first close", "second close"],
      });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      held.restore();
      dispose.mockRestore();
    }
  });
});

test("a failed local save retains the instance and its operations for another attempt", async () => {
  await withClosingDocument(async ({ docId, reference }) => {
    reference.disconnect();
    const { provider } = await reference.client["_localPromise"];
    const failure = new Error("storage unavailable");
    // Fault injection at the provider boundary; the retry uses real IndexedDB.
    const write = vi
      .spyOn(provider, "transaction")
      .mockRejectedValueOnce(failure);
    try {
      reference.addChild("before failure");
      reference.doc?.forceCommit();
      await expect(reference.client["_unloadDoc"](docId)).rejects.toBe(failure);
      expect(reference.client["_docsCache"].has(docId)).toBe(true);
      reference.addChild("after failure");
      reference.doc?.forceCommit();
      await reference.client["_unloadDoc"](docId);
      expect(reference.client["_docsCache"].has(docId)).toBe(false);
      await reference.assertIDBDoc({
        doc: [],
        ops: ["before failure", "after failure"],
      });
    } finally {
      write.mockRestore();
    }
  });
});
