import { describe, test, expect } from "vitest";
import { testWrapper } from "./utils.js";

describe("Local-First 2.0", () => {
  test("reference can load and add child", async () => {
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
