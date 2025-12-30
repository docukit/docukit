import { describe, test, expect, beforeAll } from "vitest";
import {
  createClient,
  generateUserId,
  generateDocId,
  getDoc,
  tick,
  ChildNode,
} from "./utils.js";

describe.skip("Local-First Sync", () => {
  beforeAll(async () => {
    await tick(100);
  });

  describe("Authentication", () => {
    test("client with valid token connects successfully", async () => {
      const { client } = createClient();
      const docId = generateDocId();

      const doc = await getDoc(client, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      expect(doc).toBeDefined();
      expect(doc.root).toBeDefined();
    });

    test.todo("client with invalid token is rejected");

    test("multiple clients with different userIds authenticate independently", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();

      const { client: client1 } = createClient(userId1);
      const { client: client2 } = createClient(userId2);

      const docId1 = generateDocId();
      const docId2 = generateDocId();

      // Both should be able to create docs independently
      const [doc1, doc2] = await Promise.all([
        getDoc(client1, { type: "test", id: docId1, createIfMissing: true }),
        getDoc(client2, { type: "test", id: docId2, createIfMissing: true }),
      ]);

      expect(doc1).toBeDefined();
      expect(doc2).toBeDefined();
    });
  });

  describe("Same User - Shared IndexedDB", () => {
    test("two clients sync a document via shared IndexedDB", async () => {
      const docId = generateDocId();
      const sharedUserId = generateUserId();

      const { client: client1 } = createClient(sharedUserId);
      const { client: client2 } = createClient(sharedUserId);

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for sync to server and IndexedDB
      await tick(200);

      // Client 2 loads from shared IndexedDB
      const doc2 = await getDoc(client2, { type: "test", id: docId });

      expect(doc1.root.first).toBeDefined();
      expect(doc2.root.first).toBeDefined();
    });

    test("client 1 creates doc, client 2 loads it immediately", async () => {
      const docId = generateDocId();
      const sharedUserId = generateUserId();

      const { client: client1 } = createClient(sharedUserId);
      const { client: client2 } = createClient(sharedUserId);

      // Client 1 creates and saves
      await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(100);

      // Client 2 should see it
      const doc2 = await getDoc(client2, { type: "test", id: docId });
      expect(doc2).toBeDefined();
      expect(doc2.root).toBeDefined();
    });

    test("both clients make changes sequentially, all changes preserved", async () => {
      const docId = generateDocId();
      const sharedUserId = generateUserId();

      const { client: client1 } = createClient(sharedUserId);
      const { client: client2 } = createClient(sharedUserId);

      // Client 1 creates and adds first child
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick(200);

      // Client 2 loads and adds second child
      const doc2 = await getDoc(client2, { type: "test", id: docId });
      const child2 = doc2.createNode(ChildNode);
      doc2.root.append(child2);

      await tick(200);

      // Count children
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      // Both clients should see both children
      expect(count1).toBe(2);
      expect(count2).toBe(2);
    });

    test("client 1 creates multiple docs, client 2 can load all", async () => {
      const sharedUserId = generateUserId();
      const { client: client1 } = createClient(sharedUserId);
      const { client: client2 } = createClient(sharedUserId);

      // Client 1 creates 3 documents
      const docIds = [generateDocId(), generateDocId(), generateDocId()];

      await Promise.all(
        docIds.map((id) =>
          getDoc(client1, { type: "test", id, createIfMissing: true }),
        ),
      );

      await tick(200);

      // Client 2 should be able to load all
      const docs = await Promise.all(
        docIds.map((id) => getDoc(client2, { type: "test", id })),
      );

      expect(docs).toHaveLength(3);
      docs.forEach((doc) => {
        expect(doc).toBeDefined();
        expect(doc.root).toBeDefined();
      });
    });
  });

  describe("Cross-User Sync", () => {
    // TODO: Requires server to implement get-doc handler
    test.todo("user A creates doc, user B can access via server");
    test.todo("user A makes changes, user B sees them after sync");
  });

  describe("BroadcastChannel Communication", () => {
    test("changes broadcast between client instances", async () => {
      const sharedUserId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(sharedUserId);
      const { client: client2 } = createClient(sharedUserId);

      // Both clients load the same document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(100);

      const doc2 = await getDoc(client2, { type: "test", id: docId });

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for BroadcastChannel message
      await tick(100);

      // Client 2 should see the change via BroadcastChannel
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });
  });

  describe("Persistence", () => {
    test("document survives client disconnect/reconnect", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Session 1: Create document
      const { client: client1 } = createClient(userId);
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick(200);

      // Simulate disconnect (create new client instance)
      const { client: client2 } = createClient(userId);

      // Should load from IndexedDB
      const doc2 = await getDoc(client2, { type: "test", id: docId });

      expect(doc2).toBeDefined();
      expect(doc2.root.first).toBeDefined();
    });
  });
});

describe("Client/Server Operation Sync", () => {
  beforeAll(async () => {
    await tick(100);
  });

  test("should handle client sends operations + server returns no operations", async () => {
    const userId = generateUserId();
    const docId = generateDocId();

    // Create client with realTime and broadcastChannel disabled to avoid duplicate operations
    const { client } = createClient(userId, undefined, {
      realTime: false,
      broadcastChannel: false,
    });
    const doc = await getDoc(client, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    // Make a change to generate operations
    const child = doc.createNode(ChildNode);
    doc.root.append(child);

    // Wait for sync to complete
    await tick(200);

    // Verify document in memory has the child
    let childCount = 0;
    doc.root.children().forEach(() => childCount++);
    expect(childCount).toBe(1);
    expect(doc.root.first).toBe(child);
  });

  test("should handle client sends operations + server returns operations", async () => {
    const userId1 = generateUserId();
    const userId2 = generateUserId();
    const docId = generateDocId();

    // Create two clients with DIFFERENT userIds (separate IndexedDB)
    // and realTime/broadcastChannel disabled to test explicit sync
    const { client: client1 } = createClient(userId1, undefined, {
      realTime: false,
      broadcastChannel: false,
    });
    const { client: client2 } = createClient(userId2, undefined, {
      realTime: false,
      broadcastChannel: false,
    });

    // Client 1 creates document
    const doc1 = await getDoc(client1, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    // Client 1 adds a child
    const child1 = doc1.createNode(ChildNode);
    doc1.root.append(child1);

    await tick(200);

    // Client 2 loads the document from server (not from IndexedDB since different user)
    const doc2 = await getDoc(client2, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    // Wait for the initial sync/pull to complete
    await tick(200);

    // Verify doc2 has child1 from server
    let count2Before = 0;
    doc2.root.children().forEach(() => count2Before++);
    expect(count2Before).toBe(1);

    // Client 2 adds another child
    const child2 = doc2.createNode(ChildNode);
    doc2.root.append(child2);

    // Wait for client2 to sync to server
    await tick(200);

    // Unload doc1 from cache so we can reload it fresh
    await client1["_unloadDoc"](docId);

    // Reload doc1 to get child2 from server
    const doc1Reloaded = await getDoc(client1, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    // Wait for the sync/pull to complete
    await tick(200);

    // Both documents should have both children
    let count1 = 0;
    doc1Reloaded.root.children().forEach(() => count1++);
    let count2 = 0;
    doc2.root.children().forEach(() => count2++);

    expect(count1).toBe(2);
    expect(count2).toBe(2);
  });

  test("should handle client sends no operations + server returns no operations (pull with no updates)", async () => {
    const userId = generateUserId();
    const docId = generateDocId();

    // Create client with realTime and broadcastChannel disabled
    const { client } = createClient(userId, undefined, {
      realTime: false,
      broadcastChannel: false,
    });
    const doc = await getDoc(client, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    // Don't make any changes, just wait for sync
    await tick(200);

    // Document should still be valid with no children
    expect(doc).toBeDefined();
    expect(doc.root).toBeDefined();
    let childCount = 0;
    doc.root.children().forEach(() => childCount++);
    expect(childCount).toBe(0);
  });

  test("should handle client sends no operations + server returns operations (pull with updates)", async () => {
    const userId1 = generateUserId();
    const userId2 = generateUserId();
    const docId = generateDocId();

    // Create two clients with DIFFERENT userIds and realTime/broadcastChannel disabled
    const { client: client1 } = createClient(userId1, undefined, {
      realTime: false,
      broadcastChannel: false,
    });
    const { client: client2 } = createClient(userId2, undefined, {
      realTime: false,
      broadcastChannel: false,
    });

    // Client 1 creates document and adds children
    const doc1 = await getDoc(client1, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    const child1 = doc1.createNode(ChildNode);
    const child2 = doc1.createNode(ChildNode);
    doc1.root.append(child1);
    doc1.root.append(child2);

    // Wait for client 1 to sync to server
    await tick(200);

    // Client 2 loads document - this is a "pull" since it has no local operations
    // but should receive the operations from the server
    const doc2 = await getDoc(client2, {
      type: "test",
      id: docId,
      createIfMissing: true,
    });

    // Wait for the sync/pull to complete
    await tick(200);

    // Client 2 should see both children from server
    let count2 = 0;
    doc2.root.children().forEach(() => count2++);
    expect(count2).toBe(2);
  });
});
