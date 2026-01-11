import { describe, test, expect } from "vitest";
import { emptyIDB, testWrapper, tick } from "./utils.js";
import type { JsonDoc, Operations } from "docnode";
import type { DocSyncEvents } from "../../../packages/docsync/dist/src/shared/types.js";

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
      reference.addChild("Hello");
      reference.assertMemoryDoc(["Hello"]);
      await tick(0.1);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });

      await reference.waitSync();
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
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });

      // websocket
      await otherDevice.waitSync();
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

  test("requests are batched even without local throttling", async () => {
    await testWrapper(async ({ reference }) => {
      await reference.loadDoc();
      await tick();

      // TODO
      // Currently throttling is not implemented, but later we should disable it:
      // reference["_throttle"] = false;

      const childrenArray = [];

      for (let i = 0; i < 101; i++) {
        reference.addChild(`A${i}`);
        childrenArray.push(`A${i}`);
        reference.doc?.forceCommit();
      }
      await tick(50); // Wait for batched operations to sync
      expect(childrenArray.length).toBe(101);
      await reference.assertIDBDoc({ clock: 1, doc: childrenArray, ops: [] });
      expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);
    });
  });

  test("squash operations", async () => {
    await testWrapper(async ({ reference, otherDevice }) => {
      await reference.loadDoc();

      // Wait for all clients to subscribe to the room
      await tick();

      const childrenArray: string[] = [];

      for (let i = 1; i <= 100; i++) {
        reference.addChild(`A${i}`);
        childrenArray.push(`A${i}`);
        reference.doc?.forceCommit();
        await tick(1);
      }
      expect(childrenArray.length).toBe(100);
      expect(reference.reqSpy).toHaveBeenCalledTimes(101);
      expect(otherDevice.reqSpy).toHaveBeenCalledTimes(0);

      await otherDevice.loadDoc();
      await tick();
      expect(otherDevice.reqSpy).toHaveBeenCalledTimes(1);
      expect(otherDevice.reqSpy).toHaveBeenCalledWith("sync-operations", {
        docId: expect.any(String) as unknown,
        clock: 0,
        operations: [],
      });

      // For async functions, resolve the promise before asserting
      const response = (await otherDevice.reqSpy.mock.results[0]
        ?.value) as DocSyncEvents<
        JsonDoc,
        Operations
      >["sync-operations"]["response"];
      expect(response).toMatchObject({
        docId: expect.any(String) as unknown,
        operations: expect.any(Array) as unknown,
        serializedDoc: null,
        clock: 100,
      });
      expect(response.operations?.length).toBe(100);

      otherDevice.unLoadDoc();

      await otherDevice.loadDoc();
      await tick();
      expect(otherDevice.reqSpy).toHaveBeenCalledTimes(3);
      expect(otherDevice.reqSpy).toHaveBeenCalledWith("sync-operations", {
        docId: expect.any(String) as unknown,
        clock: 100,
        operations: [],
      });

      const response2 = (await otherDevice.reqSpy.mock.results[2]
        ?.value) as DocSyncEvents<
        JsonDoc,
        Operations
      >["sync-operations"]["response"];
      expect(response2).toMatchObject({
        docId: expect.any(String) as unknown,
        operations: null,
        serializedDoc: expect.any(Object) as unknown,
        clock: 100,
      });
    });
  });
});
