import { describe, test, expect, beforeAll } from "vitest";
import {
  createClient,
  generateUserId,
  generateDocId,
  getDoc,
  tick,
  ChildNode,
} from "./utils.js";

describe("Multi-client Sync Integration", () => {
  beforeAll(async () => {
    await tick(100);
  });

  describe("Basic Sync", () => {
    test("two clients can sync a document", async () => {
      const docId = generateDocId();
      const sharedUserId = generateUserId();

      // Create two clients with the SAME userId (simulates same user on two tabs/devices)
      const { client: client1 } = createClient(sharedUserId);
      const { client: client2 } = createClient(sharedUserId);

      // Client 1 creates a document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      // Add a child node
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for sync to server
      await tick(200);

      // Client 2 fetches the same document (shares IndexedDB with client1)
      const doc2 = await getDoc(client2, { type: "test", id: docId });

      // Both should have the child node
      expect(doc1.root.first).toBeDefined();
      expect(doc2.root.first).toBeDefined();
    });

    test.skip("operations from one client appear on another", async () => {
      // TODO: Requires server-to-client push (WebSocket broadcasts)
    });
  });

  describe("Conflict Resolution", () => {
    test.skip("concurrent edits from multiple clients are merged", async () => {
      // TODO: Implement once real-time sync is working
    });
  });

  describe("Offline Support", () => {
    test.skip("operations made offline sync when reconnected", async () => {
      // TODO: Implement offline simulation
    });
  });
});
