import { describe, test, expect } from "vitest";
import { emptyIDB, testWrapper } from "./utils.js";

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
      await reference.assertIDBDoc({
        clock: 0,
        doc: [],
        ops: ["Hello"],
      });

      // Reconnect and sync will happen automatically
      reference.connect();
      await reference.assertIDBDoc({
        clock: 1,
        doc: ["Hello"],
        ops: [],
      });

      // LOAD OTHER TAB
      await otherTab.loadDoc();
      await otherTab.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });
      await otherTab.assertMemoryDoc(["Hello"]);
      await otherDevice.assertMemoryDoc();
      await otherDevice.assertIDBDoc();

      // LOAD OTHER DEVICE
      await otherDevice.loadDoc();
      await otherDevice.waitSync();
      // otherDevice gets operations from server and applies them
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });
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
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });
      await otherTab.assertMemoryDoc(["Hello"]);

      // broadcastChannel then IDB
      await otherDevice.assertMemoryDoc([]);
      await reference.assertIDBDoc({
        clock: 1,
        doc: ["Hello"],
        ops: [],
      });

      // websocket
      await otherDevice.assertMemoryDoc(["Hello"]);
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
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      await reference.assertIDBDoc({
        clock: 0,
        doc: [],
        ops: ["Hello"],
      });

      // broadcastChannel
      await otherTab.assertMemoryDoc(["Hello"]);
      await otherDevice.assertMemoryDoc([]);

      // websocket
      await expect(() => otherDevice.waitSync()).rejects.toThrow();
      await otherDevice.assertMemoryDoc([]);
      await otherDevice.assertIDBDoc({ clock: 0, doc: [], ops: [] });
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });

      // reference connects
      reference.connect();
      await reference.assertMemoryDoc(["Hello"]);
      await reference.assertIDBDoc({
        clock: 1,
        doc: ["Hello"],
        ops: [],
      });

      // otherDevice connects
      otherDevice.connect();
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({
        clock: 1,
        doc: ["Hello"],
        ops: [],
      });
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
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      await otherTab.assertMemoryDoc(["A"]);
      await otherDevice.assertMemoryDoc(["B"]);
      await reference.assertIDBDoc({
        clock: 0,
        doc: [],
        ops: ["A"],
      });

      // without connecting, ws doesn't work
      await otherDevice.assertMemoryDoc(["B"]);
      await reference.assertMemoryDoc(["A"]);

      // connecting
      reference.connect();
      otherTab.connect();
      otherDevice.connect();
      await reference.assertMemoryDoc(["A", "B"]);
      await otherTab.assertMemoryDoc(["A", "B"]);
      // otherDevice added B locally first, then received A from server
      // CRDT ordering may differ based on insertion order vs deterministic ID ordering
      // TODO: find a way to deterministically insert with conflicts
      await otherDevice.assertMemoryDoc(["B", "A"]);

      await reference.assertIDBDoc({ clock: 2, doc: ["A", "B"], ops: [] });
      await otherTab.assertIDBDoc({ clock: 2, doc: ["A", "B"], ops: [] });
      await otherDevice.assertIDBDoc({ clock: 2, doc: ["A", "B"], ops: [] });
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

      // fastest operations - synchronous
      reference.addChild("A");
      otherTab.addChild("B");
      otherDevice.addChild("C");
      await reference.assertMemoryDoc(["A"]);
      await otherTab.assertMemoryDoc(["B"]);
      await otherDevice.assertMemoryDoc(["C"]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      await reference.assertMemoryDoc(["A", "B"]);
      await otherTab.assertMemoryDoc(["B", "A"]);
      await otherDevice.assertMemoryDoc(["C"]);
      // IDB has ops persisted (throttle); doc is only updated after sync
      await reference.assertIDBDoc({
        clock: 0,
        doc: [],
        ops: ["A", "B"],
      });
      await otherTab.assertIDBDoc({
        clock: 0,
        doc: [],
        ops: ["A", "B"],
      });
      await otherDevice.assertIDBDoc({
        clock: 0,
        doc: [],
        ops: ["C"],
      });

      // without connecting, ws doesn't work
      await otherDevice.assertMemoryDoc(["C"]);
      await reference.assertMemoryDoc(["A", "B"]);
      await otherTab.assertMemoryDoc(["B", "A"]);

      // connecting
      reference.connect();
      otherTab.connect();
      otherDevice.connect();
      await reference.assertMemoryDoc(["A", "B", "C"]);
      await otherTab.assertMemoryDoc(["B", "A", "C"]);
      // otherDevice added B locally first, then received A from server
      // CRDT ordering may differ based on insertion order vs deterministic ID ordering
      // TODO: find a way to deterministically insert with conflicts
      await otherDevice.assertMemoryDoc(["C", "A", "B"]);

      await reference.assertIDBDoc({ clock: 3, doc: ["A", "B", "C"], ops: [] });
      await otherTab.assertIDBDoc({ clock: 3, doc: ["A", "B", "C"], ops: [] });
      // prettier-ignore
      await otherDevice.assertIDBDoc({
        clock: 3,
        doc: ["A", "B", "C"],
        ops: [],
      });
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
      await reference.assertIDBDoc({
        clock: 1,
        doc: childrenArray1,
        ops: [],
      });
      expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);

      // without batching delay
      reference.client["_batchDelay"] = 0;

      const childrenArray2 = [];

      for (let i = 0; i < 101; i++) {
        reference.addChild(`B${i}`);
        childrenArray2.push(`B${i}`);
        reference.doc?.forceCommit();
      }
      expect(childrenArray2.length).toBe(101);
      await reference.assertIDBDoc({
        clock: 2,
        doc: [...childrenArray1, ...childrenArray2],
        ops: [],
      });
      expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);
    });
  });
});
