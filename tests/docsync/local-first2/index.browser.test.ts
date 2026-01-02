import { describe, test, expect } from "vitest";
import { testWrapper } from "./utils.js";

describe("Local-First 2.0", () => {
  test("load doc", async () => {
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

  test("add child", async () => {
    await testWrapper(async (clients) => {
      await clients.reference.loadDoc();
      expect(clients.reference.doc).toBeDefined();
      expect(clients.reference.doc!.root).toBeDefined();

      // Add a child
      clients.reference.addChild("Hello");

      // Verify in memory
      clients.reference.assertMemoryDoc(["Hello"]);

      // Wait for IndexedDB sync
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify in IndexedDB
      await clients.reference.assertIDBDoc(["Hello"]);
    });
  });
});
