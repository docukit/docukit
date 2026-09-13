import { describe, test, expect, vi } from "vitest";
import { emptyIDB, testWrapper, waitForLocalBroadcast } from "./utils.js";

describe("Local-First", () => {
  test("cannot load doc twice", async () => {
    await testWrapper(async (clients) => {
      // Initially doc is undefined
      expect(clients.reference.doc).toBeUndefined();
      await clients.reference.loadDoc();
      expect(clients.reference.doc).toBeDefined();
      // Cannot load again without unloading first
      await expect(clients.reference.loadDoc()).rejects.toThrow(
        "Doc already loaded",
      );
      // Unload doc
      clients.reference.unLoadDoc();
      expect(clients.reference.doc).toBeUndefined();
      // Can load again after unloading
      await clients.reference.loadDoc();
      expect(clients.reference.doc).toBeDefined();
    });
  });

  test("before and after loading doc", async () => {
    await testWrapper(async (clients) => {
      // 1. NO CLIENT HAS DOC
      await clients.reference.assertIDBDoc();
      await clients.otherTab.assertIDBDoc();
      await clients.otherDevice.assertIDBDoc();
      await clients.reference.assertMemoryDoc();
      await clients.otherTab.assertMemoryDoc();
      await clients.otherDevice.assertMemoryDoc();

      // 2. ONLY REFERENCE LOADS DOC
      await clients.reference.loadDoc();
      await clients.reference.assertIDBDoc(emptyIDB);
      await clients.otherTab.assertIDBDoc(emptyIDB); // OtherTab shares the same IDB as reference
      await clients.otherDevice.assertIDBDoc();
      await clients.reference.assertMemoryDoc([]);
      await clients.otherTab.assertMemoryDoc();
      await clients.otherDevice.assertMemoryDoc();

      // 3. OTHER TAB LOADS DOC
      await clients.otherTab.loadDoc();
      await clients.otherTab.assertIDBDoc(emptyIDB);
      await clients.otherDevice.assertIDBDoc();
      await clients.reference.assertMemoryDoc([]);
      await clients.otherTab.assertMemoryDoc([]);
      await clients.otherDevice.assertMemoryDoc();

      // 4. OTHER DEVICE LOADS DOC
      await clients.otherDevice.loadDoc();
      await clients.reference.assertIDBDoc(emptyIDB);
      await clients.otherTab.assertIDBDoc(emptyIDB);
      await clients.otherDevice.assertIDBDoc(emptyIDB);
      await clients.reference.assertMemoryDoc([]);
      await clients.otherTab.assertMemoryDoc([]);
      await clients.otherDevice.assertMemoryDoc([]);

      // 5. OTHER DEVICE UNLOADS DOC
      clients.otherDevice.unLoadDoc();
      await clients.reference.assertIDBDoc(emptyIDB);
      await clients.otherTab.assertIDBDoc(emptyIDB);
      await clients.otherDevice.assertIDBDoc(emptyIDB);
      await clients.reference.assertMemoryDoc([]);
      await clients.otherTab.assertMemoryDoc([]);
      await clients.otherDevice.assertMemoryDoc();
    });
  });

  test("add child -> load", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      expect(reference.doc).toBeDefined();

      // Disconnect to prevent auto-sync
      reference.disconnect();

      reference.addChild("Hello");
      await reference.assertMemoryDoc(["Hello"]);
      await reference.assertIDBDoc({ doc: [], ops: ["Hello"] });

      // Reconnect and sync will happen automatically
      reference.connect();
      await reference.assertIDBDoc({ doc: ["Hello"], ops: [] });

      // LOAD OTHER TAB
      await otherTab.loadDoc();
      await otherTab.assertIDBDoc({ doc: ["Hello"], ops: [] });
      await otherTab.assertMemoryDoc(["Hello"]);
      await otherDevice.assertMemoryDoc();
      await otherDevice.assertIDBDoc();

      // LOAD OTHER DEVICE
      await otherDevice.loadDoc();
      // otherDevice gets operations from server and applies them
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ doc: ["Hello"], ops: [] });
    });
  });

  test("same-user client syncs operations persisted before server debounce", async () => {
    await testWrapper(async ({ docId, reference, otherTab, otherDevice }) => {
      const syncCallCount = (client: typeof reference) =>
        client.reqSpy.mock.calls.filter(
          ([event, payload]) => event === "sync" && payload.docId === docId,
        ).length;

      otherTab.disconnect();
      otherDevice.disconnect();

      await reference.loadDoc();
      await reference.assertIDBDoc(emptyIDB);
      reference.client["_singleClientMaxDebounce"] = 1500;
      reference.client["_collabMaxDebounce"] = 1500;
      const referenceSyncCallsBeforeChange = syncCallCount(reference);

      reference.addChild("Hello");
      await reference.assertMemoryDoc(["Hello"]);
      await reference.assertIDBDoc({ doc: [], ops: ["Hello"] });
      expect(syncCallCount(reference)).toBe(referenceSyncCallsBeforeChange);

      reference.disconnect();
      reference.unLoadDoc();

      const otherTabSyncCallsBeforeLoad = syncCallCount(otherTab);
      await otherTab.loadDoc();
      await otherTab.assertMemoryDoc(["Hello"]);
      await otherTab.assertIDBDoc({ doc: [], ops: ["Hello"] });
      await otherTab.assertCanUndo(false);
      expect(syncCallCount(otherTab)).toBe(otherTabSyncCallsBeforeLoad);

      otherTab.connect();
      await otherTab.assertIDBDoc({ doc: ["Hello"], ops: [] });
      await otherTab.assertCanUndo(false);
      expect(syncCallCount(otherTab)).toBeGreaterThan(
        otherTabSyncCallsBeforeLoad,
      );

      otherDevice.connect();
      await otherDevice.loadDoc();
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ doc: ["Hello"], ops: [] });
    });
  });

  test("load -> add child", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      // fastest operations - synchronous
      reference.addChild("Hello");
      await reference.assertMemoryDoc(["Hello"]);
      await otherTab.assertMemoryDoc([]);
      await otherDevice.assertMemoryDoc([]);
      await reference.assertIDBDoc({ doc: [], ops: [] });
      await waitForLocalBroadcast();
      await otherTab.assertMemoryDoc(["Hello"]);

      // broadcastChannel then IDB
      await reference.assertIDBDoc({ doc: ["Hello"], ops: [] });

      // websocket
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertCanUndo(false);
    });
  });

  test("reconnect preserves undo when concurrent operations replace the doc", async () => {
    await testWrapper(async ({ reference, otherDevice }) => {
      await reference.loadDoc();
      await otherDevice.loadDoc();
      reference.doc?.forceCommit();
      otherDevice.doc?.forceCommit();

      reference.addChild("Earlier");
      reference.doc?.forceCommit();
      await reference.assertIDBDoc({ doc: ["Earlier"], ops: [] });
      await otherDevice.assertMemoryDoc(["Earlier"]);

      reference.disconnect();

      reference.addChild("Local");
      reference.doc?.forceCommit();
      await reference.assertIDBDoc({ doc: ["Earlier"], ops: ["Local"] });
      await reference.assertCanUndo(true);
      const liveDoc = reference.doc;

      otherDevice.addChild("Remote");
      otherDevice.doc?.forceCommit();
      await otherDevice.assertIDBDoc({ doc: ["Earlier", "Remote"], ops: [] });

      reference.connect();

      await reference.assertMemoryDoc(["Earlier", "Local", "Remote"]);
      expect(reference.doc).not.toBe(liveDoc);
      await reference.assertCanUndo(true);

      reference.doc?.undoManager.undo();
      await reference.assertMemoryDoc(["Earlier", "Remote"]);
      await reference.assertCanUndo(true);

      reference.doc?.undoManager.undo();
      await reference.assertMemoryDoc(["Remote"]);
    });
  });

  test("reconnect preserves an edit made during asynchronous reconciliation", async () => {
    await testWrapper(async ({ reference, otherDevice }) => {
      await reference.loadDoc();
      await otherDevice.loadDoc();
      reference.doc?.forceCommit();
      otherDevice.doc?.forceCommit();

      reference.disconnect();
      reference.addChild("Local");
      reference.doc?.forceCommit();
      await reference.assertIDBDoc({ doc: [], ops: ["Local"] });

      otherDevice.addChild("Remote");
      otherDevice.doc?.forceCommit();
      await otherDevice.assertIDBDoc({ doc: ["Remote"], ops: [] });

      const local = await reference.client["_localPromise"];
      const provider = local.provider;
      const transaction = provider.transaction.bind(provider);
      let injectEdit = true;
      const transactionSpy = vi
        .spyOn(provider, "transaction")
        .mockImplementation((mode, callback) => {
          if (mode !== "readwrite" || !injectEdit) {
            return transaction(mode, callback);
          }
          injectEdit = false;
          return transaction(mode, async (ctx) => {
            const result = callback(ctx);
            reference.addChild("During reconciliation");
            reference.doc?.forceCommit();
            return result;
          });
        });

      const liveDoc = reference.doc;
      try {
        reference.connect();

        await reference.assertMemoryDoc([
          "Remote",
          "Local",
          "During reconciliation",
        ]);
        expect(reference.doc).not.toBe(liveDoc);

        reference.doc?.undoManager.undo();
        await reference.assertMemoryDoc(["Remote", "Local"]);
        reference.doc?.undoManager.undo();
        await reference.assertMemoryDoc(["Remote"]);
      } finally {
        transactionSpy.mockRestore();
      }
    });
  });

  test("local broadcasts keep undo and redo in the originating tab", async () => {
    await testWrapper(async ({ reference, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      reference.doc?.forceCommit();
      otherTab.doc?.forceCommit();

      reference.addChild("Hello");
      reference.doc?.forceCommit();
      await waitForLocalBroadcast();
      await otherTab.assertMemoryDoc(["Hello"]);
      await reference.assertMemoryDoc(["Hello"]);

      await reference.assertCanUndo(true);
      await otherTab.assertCanUndo(false);

      otherTab.doc?.undoManager.undo();
      await otherTab.assertMemoryDoc(["Hello"]);

      reference.doc?.undoManager.undo();
      await otherTab.assertMemoryDoc([]);
      await otherTab.assertCanUndo(false);
      expect(reference.doc?.undoManager.canRedo()).toBe(true);
      expect(otherTab.doc?.undoManager.canRedo()).toBe(false);

      otherTab.addChild("Other tab");
      otherTab.doc?.forceCommit();
      await reference.assertMemoryDoc(["Other tab"]);
      expect(reference.doc?.undoManager.canRedo()).toBe(true);

      reference.doc?.undoManager.redo();
      await otherTab.assertMemoryDoc(["Other tab", "Hello"]);
      otherTab.doc?.undoManager.undo();
      await reference.assertMemoryDoc(["Hello"]);
      await reference.assertCanUndo(true);
    });
  });

  test("local broadcast changes can opt out of undo history in every tab", async () => {
    await testWrapper(async ({ reference, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      reference.doc?.forceCommit();
      otherTab.doc?.forceCommit();

      reference.addChildSkippingUndo("Hello");
      await waitForLocalBroadcast();

      await reference.assertMemoryDoc(["Hello"]);
      await otherTab.assertMemoryDoc(["Hello"]);
      await reference.assertCanUndo(false);
      await otherTab.assertCanUndo(false);

      reference.doc?.undoManager.undo();
      otherTab.doc?.undoManager.undo();
      await reference.assertMemoryDoc(["Hello"]);
      await otherTab.assertMemoryDoc(["Hello"]);
    });
  });

  test("add child -> connect", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      reference.disconnect();
      otherTab.disconnect();
      otherDevice.disconnect();

      // fastest operations - synchronous
      reference.addChild("Hello");
      await reference.assertMemoryDoc(["Hello"]);
      await otherTab.assertMemoryDoc([]);
      await otherDevice.assertMemoryDoc([]);
      await reference.assertIDBDoc({ doc: [], ops: [] });

      await reference.assertIDBDoc({ doc: [], ops: ["Hello"] });

      // broadcastChannel
      await otherTab.assertMemoryDoc(["Hello"]);
      await otherDevice.assertMemoryDoc([]);

      // websocket
      await otherDevice.assertMemoryDoc([]);
      await otherDevice.assertIDBDoc({ doc: [], ops: [] });
      await reference.assertIDBDoc({ doc: [], ops: ["Hello"] });

      // reference connects
      reference.connect();
      await reference.assertMemoryDoc(["Hello"]);
      await reference.assertIDBDoc({ doc: ["Hello"], ops: [] });

      // otherDevice connects
      otherDevice.connect();
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ doc: ["Hello"], ops: [] });
    });
  });

  test("both devices add child -> connect", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      reference.disconnect();
      otherTab.disconnect();
      otherDevice.disconnect();

      // fastest operations - synchronous
      reference.addChild("A");
      otherDevice.addChild("B");
      await reference.assertMemoryDoc(["A"]);
      await otherTab.assertMemoryDoc([]);
      await otherDevice.assertMemoryDoc(["B"]);
      await reference.assertIDBDoc({ doc: [], ops: [] });

      await otherTab.assertMemoryDoc(["A"]);
      await otherDevice.assertMemoryDoc(["B"]);
      await reference.assertIDBDoc({ doc: [], ops: ["A"] });

      // without connecting, ws doesn't work
      await otherDevice.assertMemoryDoc(["B"]);
      await reference.assertMemoryDoc(["A"]);

      // connecting
      reference.connect();
      otherTab.connect();
      otherDevice.connect();
      await reference.assertMemoryDoc(["A", "B"]);
      await otherTab.assertMemoryDoc(["A", "B"]);
      await otherDevice.assertMemoryDoc(["A", "B"]);

      await reference.assertIDBDoc({ doc: ["A", "B"], ops: [] });
      await otherTab.assertIDBDoc({ doc: ["A", "B"], ops: [] });
      await otherDevice.assertIDBDoc({ doc: ["A", "B"], ops: [] });
    });
  });

  test("both tabs add child -> connect", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      reference.disconnect();
      otherTab.disconnect();
      otherDevice.disconnect();

      // Each tab applies its own edit at once. The tab that owned the document
      // persists its edit; the other one takes the document over to persist
      // its own, and rebuilds its live doc from the shared store on the way.
      reference.addChild("A");
      otherTab.addChild("B");
      otherDevice.addChild("C");
      await otherDevice.assertMemoryDoc(["C"]);
      await otherDevice.assertIDBDoc({ doc: [], ops: ["C"] });

      // Both tabs end up with the same order, which is the order the store
      // holds: there is only one writer.
      await expect
        .poll(() => ({
          reference: reference.readMemoryDoc(),
          otherTab: otherTab.readMemoryDoc(),
        }))
        .toSatisfy(
          (docs: { reference?: string[]; otherTab?: string[] }) =>
            docs.reference?.length === 2 &&
            docs.reference.includes("A") &&
            docs.reference.includes("B") &&
            JSON.stringify(docs.otherTab) === JSON.stringify(docs.reference),
        );
      const localOrder = reference.readMemoryDoc()!;
      await reference.assertIDBDoc({ doc: [], ops: localOrder });

      // without connecting, ws doesn't work
      await otherDevice.assertMemoryDoc(["C"]);

      // connecting
      reference.connect();
      otherTab.connect();
      otherDevice.connect();
      const merged = [...localOrder, "C"];
      await reference.assertMemoryDoc(merged);
      await otherTab.assertMemoryDoc(merged);
      await otherDevice.assertMemoryDoc(merged);

      await reference.assertIDBDoc({ doc: merged, ops: [] });
      await otherTab.assertIDBDoc({ doc: merged, ops: [] });
      await otherDevice.assertIDBDoc({ doc: merged, ops: [] });
    });
  });

  test("requests are batched even without local batching delay", async () => {
    await testWrapper(async ({ reference }) => {
      await reference.loadDoc();

      // with batching delay
      const childrenArray1 = [];
      for (let i = 0; i < 101; i++) {
        reference.addChild(`A${i}`);
        childrenArray1.push(`A${i}`);
        reference.doc?.forceCommit();
      }
      expect(childrenArray1.length).toBe(101);
      await reference.assertIDBDoc({ doc: childrenArray1, ops: [] });
      expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);
      const requestsAfterFirstBatch = reference.reqSpy.mock.calls.length;

      // without batching delay
      reference.client["_collabMaxDebounce"] = 0;
      reference.client["_singleClientMaxDebounce"] = 0;

      const childrenArray2 = [];

      for (let i = 0; i < 101; i++) {
        reference.addChild(`B${i}`);
        childrenArray2.push(`B${i}`);
        reference.doc?.forceCommit();
      }
      expect(childrenArray2.length).toBe(101);
      await reference.assertIDBDoc({
        doc: [...childrenArray1, ...childrenArray2],
        ops: [],
      });
      expect(
        reference.reqSpy.mock.calls.length - requestsAfterFirstBatch,
      ).toBeLessThan(4);
    });
  });
});

describe("Ownership", () => {
  test("the first tab to load a document owns it and a later tab mirrors it", async () => {
    await testWrapper(async ({ reference, otherTab, otherDevice }) => {
      await reference.loadDoc();
      expect(reference.role()).toBe("owner");

      await otherTab.loadDoc();
      expect(otherTab.role()).toBe("mirror");
      expect(reference.role()).toBe("owner");
      // A mirror's query settles without a sync of its own: the owner keeps
      // the document fresh.
      await otherTab.waitForSync();
      expect(otherTab.syncCount()).toBe(0);

      await otherDevice.loadDoc();
      otherDevice.addChild("Remote");
      await reference.assertMemoryDoc(["Remote"]);
      // The mirror receives the change through the owner's broadcast.
      await otherTab.assertMemoryDoc(["Remote"]);
      expect(otherTab.syncCount()).toBe(0);
    });
  });

  test("a mirror keeps its edit in memory until it owns the document", async () => {
    await testWrapper(async ({ reference, otherTab }) => {
      await reference.loadDoc();
      await reference.waitForSync();
      await otherTab.loadDoc();
      expect(otherTab.role()).toBe("mirror");
      const referenceSyncs = reference.syncCount();

      otherTab.addChild("Hello");
      await otherTab.assertMemoryDoc(["Hello"]);
      await expect.poll(() => otherTab.role()).toBe("owner");
      expect(reference.role()).toBe("mirror");
      await otherTab.assertIDBDoc({ doc: ["Hello"], ops: [] });
      await reference.assertMemoryDoc(["Hello"]);
      // The previous owner persisted nothing for an edit it did not make.
      expect(reference.syncCount()).toBe(referenceSyncs);
    });
  });

  test("unloading the owner hands the document to a tab that still has it", async () => {
    await testWrapper(async ({ reference, otherTab, otherDevice }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      expect(otherTab.role()).toBe("mirror");

      reference.unLoadDoc();
      await expect.poll(() => otherTab.role()).toBe("owner");

      await otherDevice.loadDoc();
      otherDevice.addChild("Remote");
      await otherTab.assertMemoryDoc(["Remote"]);
      await otherTab.assertIDBDoc({ doc: ["Remote"], ops: [] });
    });
  });

  test("closing the owner tab hands the document over and persists its edit", async () => {
    await testWrapper(async ({ reference, otherTab, otherDevice }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      reference.disconnect();
      reference.addChild("Unsent");
      await reference.assertMemoryDoc(["Unsent"]);

      reference.closeTab();
      await expect.poll(() => otherTab.role()).toBe("owner");
      expect(reference.role()).toBe("mirror");
      // The closing tab left its edit in the store; the new owner pushes it.
      await otherTab.assertIDBDoc({ doc: ["Unsent"], ops: [] });

      await otherDevice.loadDoc();
      await otherDevice.assertMemoryDoc(["Unsent"]);
    });
  });

  test("tabs opening a document at once all mirror its owner", async () => {
    await testWrapper(
      async ({ reference, otherTab, otherDevice, openAnotherTab }) => {
        const thirdTab = await openAnotherTab();
        await reference.loadDoc();
        expect(reference.role()).toBe("owner");

        await Promise.all([otherTab.loadDoc(), thirdTab.loadDoc()]);
        const tabs = [reference, otherTab, thirdTab];
        expect(tabs.filter((tab) => tab.role() === "owner").length).toBe(1);

        await otherDevice.loadDoc();
        otherDevice.addChild("Remote");
        await reference.assertMemoryDoc(["Remote"]);
        await otherTab.assertMemoryDoc(["Remote"]);
        await thirdTab.assertMemoryDoc(["Remote"]);
        expect(tabs.filter((tab) => tab.role() === "owner").length).toBe(1);
      },
    );
  });

  test("a mirror receives collaborator presence through its subscription", async () => {
    await testWrapper(async ({ docId, reference, otherTab, otherDevice }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();
      expect(otherTab.role()).toBe("mirror");

      const seen: Record<string, unknown>[] = [];
      const off = otherTab.client.getPresence({ docId }, (presence) => {
        seen.push(presence);
      });
      // Presence reaches the server only once the document has collaborators.
      await expect
        .poll(() => otherDevice.client["_collabDocIds"].has(docId))
        .toBe(true);
      otherDevice.client.setPresence({ docId, presence: { cursor: 1 } });

      await expect
        .poll(() => seen.at(-1)?.[otherDevice.client["_clientId"]])
        .toStrictEqual({ cursor: 1 });
      off();
    });
  });

  test("a mirror settles its query on the owner's syncs", async () => {
    await testWrapper(async ({ docId, reference, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      expect(otherTab.role()).toBe("mirror");

      const observer = otherTab.client.getDocObserver({
        type: "test",
        id: docId,
      });
      otherTab.disconnect();
      await expect
        .poll(() => observer.getSnapshot().fetchStatus)
        .toBe("paused");
      otherTab.connect();
      await expect
        .poll(() => observer.getSnapshot().fetchStatus)
        .toBe("fetching");
      await reference.client["_sync"](docId);
      await otherTab.waitForSync();
    });
  });
});
