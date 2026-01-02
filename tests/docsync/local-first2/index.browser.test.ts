import { describe, test, expect } from "vitest";
import { emptyIDB, testWrapper } from "./utils.js";
import { tick } from "../utils.js";

describe("Local-First 2.0", () => {
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

  test("load after adding child", async () => {
    await testWrapper(async ({ reference, otherDevice, otherTab }) => {
      await reference.loadDoc();
      expect(reference.doc).toBeDefined();
      await reference.addChild("Hello");
      reference.assertMemoryDoc(["Hello"]);
      await reference.assertIDBDoc({ clock: 0, doc: [], ops: ["Hello"] });
      // Wait for sync to complete before checking IDB
      await tick(50); // Give time for saveRemote to complete
      // After sync: operations are consolidated into doc
      // Clock = 2 because: 1) initial loadDoc sync, 2) addChild sync
      // TODO: this is wrong, clock should be 1 because addChild should not increment the clock
      await reference.assertIDBDoc({ clock: 2, doc: ["Hello"], ops: [] });

      // LOAD OTHER TAB
      await otherTab.loadDoc();
      await otherTab.assertIDBDoc({ clock: 2, doc: ["Hello"], ops: [] });
      otherTab.assertMemoryDoc(["Hello"]);
      otherDevice.assertMemoryDoc();
      await otherDevice.assertIDBDoc();

      // LOAD OTHER DEVICE
      await otherDevice.loadDoc();
      await tick(50);
      // otherDevice gets operations from server and applies them
      otherDevice.assertMemoryDoc(["Hello"]);
    });
  });
});
