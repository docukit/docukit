import { describe, test, expect } from "vitest";
import { testWrapper } from "./utils.js";

describe("Local-First 2.0", () => {
  test("setupClients creates 4 clients with correct configuration", async () => {
    await testWrapper(async (clients) => {
      // Verify docId is shared
      expect(clients.docId).toBeDefined();

      // Verify all clients exist
      expect(clients.reference.client).toBeDefined();
      expect(clients.otherTab.client).toBeDefined();
      expect(clients.otherTabAndUser.client).toBeDefined();
      expect(clients.otherDevice.client).toBeDefined();

      // Verify initial state
      expect(clients.reference.doc).toBeUndefined();
      expect(clients.otherTab.doc).toBeUndefined();
      expect(clients.otherTabAndUser.doc).toBeUndefined();
      expect(clients.otherDevice.doc).toBeUndefined();
    });
  });

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
