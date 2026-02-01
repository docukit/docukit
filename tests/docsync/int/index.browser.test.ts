import { describe, test, expect } from "vitest";
import { emptyIDB, testWrapper, tick } from "./utils.js";

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
      clients.reference.assertMemoryDoc();
      clients.otherTab.assertMemoryDoc();
      clients.otherDevice.assertMemoryDoc();

      // 2. ONLY REFERENCE LOADS DOC
      await clients.reference.loadDoc();
      await clients.reference.assertIDBDoc(emptyIDB);
      await clients.otherTab.assertIDBDoc(emptyIDB); // OtherTab shares the same IDB as reference
      await clients.otherDevice.assertIDBDoc();
      clients.reference.assertMemoryDoc([]);
      clients.otherTab.assertMemoryDoc();
      clients.otherDevice.assertMemoryDoc();

      // 3. OTHER TAB LOADS DOC
      await clients.otherTab.loadDoc();
      await clients.otherTab.assertIDBDoc(emptyIDB);
      await clients.otherDevice.assertIDBDoc();
      clients.reference.assertMemoryDoc([]);
      clients.otherTab.assertMemoryDoc([]);
      clients.otherDevice.assertMemoryDoc();

      // 4. OTHER DEVICE LOADS DOC
      await clients.otherDevice.loadDoc();
      await clients.reference.assertIDBDoc(emptyIDB);
      await clients.otherTab.assertIDBDoc(emptyIDB);
      await clients.otherDevice.assertIDBDoc(emptyIDB);
      clients.reference.assertMemoryDoc([]);
      clients.otherTab.assertMemoryDoc([]);
      clients.otherDevice.assertMemoryDoc([]);

      // 5. OTHER DEVICE UNLOADS DOC
      clients.otherDevice.unLoadDoc();
      await clients.reference.assertIDBDoc(emptyIDB);
      await clients.otherTab.assertIDBDoc(emptyIDB);
      await clients.otherDevice.assertIDBDoc(emptyIDB);
      clients.reference.assertMemoryDoc([]);
      clients.otherTab.assertMemoryDoc([]);
      clients.otherDevice.assertMemoryDoc();
    });
  });

  test("add child -> load", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      expect(reference.doc).toBeDefined();

      // Disconnect to prevent auto-sync
      reference.disconnect();

      reference.addChild("Hello");
      reference.assertMemoryDoc(["Hello"]);
      await tick(55); // Wait for throttle to save ops to IDB
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });

      // Reconnect and sync will happen automatically
      reference.connect();
      await tick(20); // Wait for reconnection and sync
      await reference.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });

      // LOAD OTHER TAB
      await otherTab.loadDoc();
      await otherTab.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });
      otherTab.assertMemoryDoc(["Hello"]);
      otherDevice.assertMemoryDoc();
      await otherDevice.assertIDBDoc();

      // LOAD OTHER DEVICE
      await otherDevice.loadDoc();
      await otherDevice.waitSync();
      // otherDevice gets operations from server and applies them
      otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });
    });
  });

  test("load -> add child", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      // Wait for all clients to subscribe to the room
      await tick();

      // fastest operations - synchronous
      reference.addChild("Hello");
      reference.assertMemoryDoc(["Hello"]);
      otherTab.assertMemoryDoc([]);
      otherDevice.assertMemoryDoc([]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      // broadcastChannel
      otherTab.assertMemoryDoc(["Hello"]);
      otherDevice.assertMemoryDoc([]);
      await tick(50); // Wait for throttle to save ops to IDB
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });
      await tick(); // Wait for sync request to complete
      await reference.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });

      // websocket
      otherDevice.assertMemoryDoc(["Hello"]);
    });
  });

  test("add child -> connect", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      // Wait for all clients to subscribe to the room
      await tick();

      reference.disconnect();
      otherTab.disconnect();
      otherDevice.disconnect();

      // fastest operations - synchronous
      reference.addChild("Hello");
      reference.assertMemoryDoc(["Hello"]);
      otherTab.assertMemoryDoc([]);
      otherDevice.assertMemoryDoc([]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      await tick(25); // idb is throttled by 50ms
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });
      // Wait for throttle to save ops to IDB
      await tick(40);

      // broadcastChannel
      otherTab.assertMemoryDoc(["Hello"]);
      otherDevice.assertMemoryDoc([]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });

      // websocket
      await expect(() => otherDevice.waitSync()).rejects.toThrow();
      otherDevice.assertMemoryDoc([]);
      await otherDevice.assertIDBDoc({ clock: 0, doc: [], ops: [] });
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });

      // reference connects
      reference.connect();
      await tick(40);
      reference.assertMemoryDoc(["Hello"]);
      await reference.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });

      // otherDevice connects
      otherDevice.connect();
      await tick(50);
      otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ clock: 1, doc: ["Hello"], ops: [] });
    });
  });

  test("both devices add child -> connect", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();

      // Wait for all clients to subscribe to the room
      await tick();

      reference.disconnect();
      otherTab.disconnect();
      otherDevice.disconnect();

      // fastest operations - synchronous
      reference.addChild("A");
      otherDevice.addChild("B");
      reference.assertMemoryDoc(["A"]);
      otherTab.assertMemoryDoc([]);
      otherDevice.assertMemoryDoc(["B"]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      // Wait for throttle to save ops to IDB
      await tick(55);

      // broadcastChannel
      otherTab.assertMemoryDoc(["A"]);
      otherDevice.assertMemoryDoc(["B"]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["A"] });

      // without connecting, ws doesn't work
      await tick(50);
      otherDevice.assertMemoryDoc(["B"]);
      reference.assertMemoryDoc(["A"]);

      // connecting
      reference.connect();
      otherTab.connect();
      otherDevice.connect();
      await tick(40);

      reference.assertMemoryDoc(["A", "B"]);
      otherTab.assertMemoryDoc(["A", "B"]);
      // otherDevice added B locally first, then received A from server
      // CRDT ordering may differ based on insertion order vs deterministic ID ordering
      // TODO: find a way to deterministically insert with conflicts
      otherDevice.assertMemoryDoc(["B", "A"]);

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

      // Wait for all clients to subscribe to the room
      await tick();

      reference.disconnect();
      otherTab.disconnect();
      otherDevice.disconnect();

      // fastest operations - synchronous
      reference.addChild("A");
      otherTab.addChild("B");
      otherDevice.addChild("C");
      reference.assertMemoryDoc(["A"]);
      otherTab.assertMemoryDoc(["B"]);
      otherDevice.assertMemoryDoc(["C"]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: [] });

      // Wait for throttle to save ops to IDB (50ms)
      await tick(60);

      // broadcastChannel
      reference.assertMemoryDoc(["A", "B"]);
      // TODO: find a way to deterministically insert with conflicts
      otherTab.assertMemoryDoc(["B", "A"]);
      otherDevice.assertMemoryDoc(["C"]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["A", "B"] });
      await otherTab.assertIDBDoc({ clock: 0, doc: [], ops: ["A", "B"] });
      await otherDevice.assertIDBDoc({ clock: 0, doc: [], ops: ["C"] });

      // without connecting, ws doesn't work
      await tick(50);
      otherDevice.assertMemoryDoc(["C"]);
      reference.assertMemoryDoc(["A", "B"]);
      otherTab.assertMemoryDoc(["B", "A"]);

      // connecting
      reference.connect();
      otherTab.connect();
      otherDevice.connect();
      await tick(40);

      reference.assertMemoryDoc(["A", "B", "C"]);
      otherTab.assertMemoryDoc(["B", "A", "C"]);
      // otherDevice added B locally first, then received A from server
      // CRDT ordering may differ based on insertion order vs deterministic ID ordering
      // TODO: find a way to deterministically insert with conflicts
      otherDevice.assertMemoryDoc(["C", "A", "B"]);

      await reference.assertIDBDoc({ clock: 3, doc: ["A", "B", "C"], ops: [] });
      await otherTab.assertIDBDoc({ clock: 3, doc: ["A", "B", "C"], ops: [] });
      // prettier-ignore
      await otherDevice.assertIDBDoc({ clock: 3, doc: ["A", "B", "C"], ops: [] });
    });
  });

  test("requests are batched even without local batching delay", async () => {
    await testWrapper(async ({ reference }) => {
      await reference.loadDoc();
      await tick();

      // with batching delay
      const childrenArray1 = [];
      for (let i = 0; i < 101; i++) {
        reference.addChild(`A${i}`);
        childrenArray1.push(`A${i}`);
        reference.doc?.forceCommit();
      }
      await tick(60); // Wait for batched operations to sync
      expect(childrenArray1.length).toBe(101);
      await reference.assertIDBDoc({ clock: 1, doc: childrenArray1, ops: [] });
      expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);

      // without batching delay
      reference.client["_batchDelay"] = 0;

      const childrenArray2 = [];

      for (let i = 0; i < 101; i++) {
        reference.addChild(`B${i}`);
        childrenArray2.push(`B${i}`);
        reference.doc?.forceCommit();
      }
      await tick(40); // Wait for batched operations to sync
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
