import { describe, test, expect } from "vitest";
import { createTestContext, emptyIDB, type ClientsSetup } from "./utils.js";
import { docNodeAdapter, yjsAdapter } from "./adapters.js";

type TestWrapper = (
  callback: (clients: ClientsSetup) => Promise<void>,
) => Promise<void>;

function defineTestSuite(testWrapper: TestWrapper, adapterName: string) {
  describe(`Local-First (${adapterName})`, () => {
    test("cannot load doc twice", async () => {
      await testWrapper(async (clients) => {
        expect(clients.reference.doc).toBeUndefined();
        await clients.reference.loadDoc();
        expect(clients.reference.doc).toBeDefined();
        await expect(clients.reference.loadDoc()).rejects.toThrow(
          "Doc already loaded",
        );
        clients.reference.unLoadDoc();
        expect(clients.reference.doc).toBeUndefined();
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
        await clients.otherTab.assertIDBDoc(emptyIDB);
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

        reference.disconnect();

        reference.addChild("Hello");
        await reference.assertMemoryDoc(["Hello"]);
        await reference.assertIDBDoc({ doc: [], ops: ["Hello"] });

        reference.connect();
        await reference.assertIDBDoc({ doc: ["Hello"], ops: [] });

        await otherTab.loadDoc();
        await otherTab.assertIDBDoc({ doc: ["Hello"], ops: [] });
        await otherTab.assertMemoryDoc(["Hello"]);
        await otherDevice.assertMemoryDoc();
        await otherDevice.assertIDBDoc();

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

        reference.addChild("Hello");
        await reference.assertMemoryDoc(["Hello"]);
        await otherTab.assertMemoryDoc([]);
        await otherDevice.assertMemoryDoc([]);
        await reference.assertIDBDoc({ doc: [], ops: [] });
        await otherTab.assertMemoryDoc(["Hello"]);

        // broadcastChannel then IDB
        await otherDevice.assertMemoryDoc([]);
        await reference.assertIDBDoc({ doc: ["Hello"], ops: [] });

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

        // connecting - CRDT conflict resolution order may vary
        reference.connect();
        otherTab.connect();
        otherDevice.connect();
        await reference.assertMemoryDoc(["A", "B"], { sorted: true });
        await otherTab.assertMemoryDoc(["A", "B"], { sorted: true });
        await otherDevice.assertMemoryDoc(["A", "B"], { sorted: true });

        await reference.assertIDBDoc(
          { doc: ["A", "B"], ops: [] },
          { sorted: true },
        );
        await otherTab.assertIDBDoc(
          { doc: ["A", "B"], ops: [] },
          { sorted: true },
        );
        await otherDevice.assertIDBDoc(
          { doc: ["A", "B"], ops: [] },
          { sorted: true },
        );
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

        reference.addChild("A");
        otherTab.addChild("B");
        otherDevice.addChild("C");
        await reference.assertMemoryDoc(["A"]);
        await otherTab.assertMemoryDoc(["B"]);
        await otherDevice.assertMemoryDoc(["C"]);
        await reference.assertIDBDoc({ doc: [], ops: [] });

        // After BroadcastChannel sync (reference <-> otherTab)
        await reference.assertMemoryDoc(["A", "B"], { sorted: true });
        await otherTab.assertMemoryDoc(["A", "B"], { sorted: true });
        await otherDevice.assertMemoryDoc(["C"]);
        await reference.assertIDBDoc(
          { doc: [], ops: ["A", "B"] },
          { sorted: true },
        );
        await otherTab.assertIDBDoc(
          { doc: [], ops: ["A", "B"] },
          { sorted: true },
        );
        await otherDevice.assertIDBDoc({ doc: [], ops: ["C"] });

        // without connecting, ws doesn't work
        await otherDevice.assertMemoryDoc(["C"]);
        await reference.assertMemoryDoc(["A", "B"], { sorted: true });
        await otherTab.assertMemoryDoc(["A", "B"], { sorted: true });

        // connecting - CRDT conflict resolution order may vary
        reference.connect();
        otherTab.connect();
        otherDevice.connect();
        await reference.assertMemoryDoc(["A", "B", "C"], { sorted: true });
        await otherTab.assertMemoryDoc(["A", "B", "C"], { sorted: true });
        await otherDevice.assertMemoryDoc(["A", "B", "C"], { sorted: true });

        await reference.assertIDBDoc(
          { doc: ["A", "B", "C"], ops: [] },
          { sorted: true },
        );
        await otherTab.assertIDBDoc(
          { doc: ["A", "B", "C"], ops: [] },
          { sorted: true },
        );
        await otherDevice.assertIDBDoc(
          { doc: ["A", "B", "C"], ops: [] },
          { sorted: true },
        );
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
          reference.forceCommit();
        }
        expect(childrenArray1.length).toBe(101);
        await reference.assertIDBDoc({ doc: childrenArray1, ops: [] });
        expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);

        // without batching delay
        reference.setBatchDelay(0);

        const childrenArray2 = [];
        for (let i = 0; i < 101; i++) {
          reference.addChild(`B${i}`);
          childrenArray2.push(`B${i}`);
          reference.forceCommit();
        }
        expect(childrenArray2.length).toBe(101);
        await reference.assertIDBDoc({
          doc: [...childrenArray1, ...childrenArray2],
          ops: [],
        });
        expect(reference.reqSpy.mock.calls.length).toBeLessThan(4);
      });
    });
  });
}

// Run the same test suite for both CRDT backends
const docNodeCtx = createTestContext(docNodeAdapter);
const yjsCtx = createTestContext(yjsAdapter);

defineTestSuite(docNodeCtx.testWrapper, "DocNode");
defineTestSuite(yjsCtx.testWrapper, "Yjs");
