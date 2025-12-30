import { describe, test, expect, beforeAll, afterEach } from "vitest";
import {
  createClient,
  generateUserId,
  generateDocId,
  getDoc,
  getDocWithCleanup,
  tick,
  ChildNode,
  spyOnBroadcastChannel,
  spyOnDirtyEvent,
} from "./utils.js";

/**
 * Real-Time Collaboration Tests
 *
 * These tests verify the behavior of real-time synchronization between clients.
 *
 * Two sync mechanisms:
 * 1. BroadcastChannel: Same-device, same-origin tabs (same userId)
 * 2. Server dirty events: Cross-device, any origin (any userId, requires server)
 *
 * Test organization:
 * - Same User scenarios: Both mechanisms can work (shared IndexedDB + BroadcastChannel)
 * - Different Users scenarios: Only server RTC works (separate IndexedDB per user)
 */

describe.sequential("Real-Time Collaboration", () => {
  beforeAll(async () => {
    // Wait a bit for server to be fully ready
    await tick(100);
  });

  afterEach(async () => {
    // Wait for async operations to complete after each test
    await tick(100);
  });

  describe("Same User - Both Mechanisms Available", () => {
    test("Config 1: realTime=true + broadcastChannel=true - both mechanisms active", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Same user, both clients share IndexedDB
      const { client: client1 } = createClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(400); // Wait for saveRemote and subscription to complete

      // Client 2 loads document (from shared IndexedDB)
      const doc2 = await getDoc(client2, { type: "test", id: docId });

      await tick(400); // Wait for client2's subscription to complete

      // Verify BroadcastChannel is initialized (after getDoc resolves _localPromise)
      expect(client1["_broadcastChannel"]).toBeDefined();
      expect(client2["_broadcastChannel"]).toBeDefined();

      // Verify subscriptions are active (realTime: true)
      const serverSync1 = client1["_serverSync"];
      const serverSync2 = client2["_serverSync"];
      expect(serverSync1!["_subscribedDocs"].size).toBeGreaterThan(0);
      expect(serverSync2!["_subscribedDocs"].size).toBeGreaterThan(0);

      // Spy on both mechanisms AFTER initial load
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for async onChange to fire
      await tick(3);

      // Verify BroadcastChannel was used
      expect(bc1Spy.mock.calls.length).toBe(1);

      // Client 2 sees the change immediately (via BroadcastChannel)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);

      await tick(10);

      // Verify dirty event triggered a sync on client2
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);
    });

    test("Config 2: realTime=true + broadcastChannel=false - verify broken behavior (negative test)", async () => {
      // NEGATIVE TEST: This configuration is known to be broken
      //
      // Problem: Same-user clients share IndexedDB (same userId), which includes the clock.
      // When client1 pushes operations, the server updates the clock to N.
      // Both clients now have clock=N in their shared IndexedDB.
      // When dirty event fires for client2, it pulls with clock=N.
      // Server responds with empty operations (no ops with clock > N).
      // Client2's in-memory document never updates.
      //
      // This test verifies:
      // 1. Documents remain out of sync (in-memory state differs)
      // 2. BroadcastChannel is NOT accidentally used (it's disabled)
      // 3. After reload, documents sync (IndexedDB has the changes)

      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      // Verify BroadcastChannel is NOT initialized
      expect(client1["_broadcastChannel"]).toBeUndefined();
      expect(client2["_broadcastChannel"]).toBeUndefined();

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(5);

      // Client 2 loads document with cleanup
      const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
        client2,
        { type: "test", id: docId },
      );

      await tick(5);

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for onChange to trigger + server sync + dirty event
      await tick(15);

      // ❌ NEGATIVE ASSERTION: Client 2 should NOT see the change in memory
      // (This verifies the broken behavior)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0); // Broken: in-memory doc is stale

      // ✅ Verify BroadcastChannel was not used (we can't spy on it since it's disabled)
      // Already verified above that _broadcastChannel is undefined

      // Now unload and reload Client2's document
      cleanup2(); // Unload the stale document
      await tick(5);

      // Reload from IndexedDB
      const doc2Reloaded = await getDoc(client2, { type: "test", id: docId });

      await tick(5);

      // ✅ POSITIVE ASSERTION: After reload, Client2 sees the changes (from IndexedDB)
      let countAfterReload = 0;
      doc2Reloaded.root.children().forEach(() => countAfterReload++);
      expect(countAfterReload).toBe(1); // IndexedDB has the change!
    });

    test("Config 3: realTime=false + broadcastChannel=true - only BroadcastChannel", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(5);

      // Client 2 loads document
      const doc2 = await getDoc(client2, { type: "test", id: docId });

      await tick(5);

      // Verify BroadcastChannel IS initialized (after getDoc resolves _localPromise)
      expect(client1["_broadcastChannel"]).toBeDefined();
      expect(client2["_broadcastChannel"]).toBeDefined();

      // Verify subscriptions are NOT active (realTime: false)
      const serverSync1 = client1["_serverSync"];
      const serverSync2 = client2["_serverSync"];
      expect(serverSync1!["_subscribedDocs"].size).toBe(0);
      expect(serverSync2!["_subscribedDocs"].size).toBe(0);

      // Spy on both mechanisms AFTER initial load
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for async onChange
      await tick(3);

      // Verify BroadcastChannel was used
      expect(bc1Spy.mock.calls.length).toBe(1);

      // BroadcastChannel propagates quickly
      await tick(5);

      // Verify dirty event was NOT triggered (realTime: false)
      expect(dirtySpy2.mock.calls.length).toBe(0);

      // Client 2 sees the change via BroadcastChannel
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("Config 4: realTime=false + broadcastChannel=false - no automatic sync, verify reload", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      // Verify both mechanisms are disabled
      expect(client1["_broadcastChannel"]).toBeUndefined();
      expect(client2["_broadcastChannel"]).toBeUndefined();

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(5);

      // Client 2 loads document with cleanup
      const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
        client2,
        { type: "test", id: docId },
      );

      await tick(5);

      // Verify subscriptions are NOT active
      const serverSync2 = client2["_serverSync"];
      expect(serverSync2!["_subscribedDocs"].size).toBe(0);

      // Spy on dirty event AFTER initial load
      const dirtySpy2 = spyOnDirtyEvent(client2);
      dirtySpy2.mockClear();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick(10);

      // Verify dirty event was NOT triggered
      expect(dirtySpy2.mock.calls.length).toBe(0);

      // Client 2 should NOT see the change (no automatic sync)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0);

      // Unload and reload Client2's document
      cleanup2();
      await tick(5);

      // Reload from IndexedDB (should have Client1's changes now)
      const doc2Reloaded = await getDoc(client2, { type: "test", id: docId });

      await tick(5);

      // After reload, Client2 should see the changes (persisted in IndexedDB)
      let countAfterReload = 0;
      doc2Reloaded.root.children().forEach(() => countAfterReload++);
      expect(countAfterReload).toBe(1);
    });
  });

  describe("Different Users - Only Server RTC Available", () => {
    test("realTime=true - server dirty events work across users", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId1);
      const { client: client2 } = createClient(userId2);

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(10);

      // Client 2 loads document from server (different IndexedDB)
      const doc2 = await getDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(5);

      // Spy on mechanisms
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for async onChange
      await tick(3);

      // BroadcastChannel is called but client2 won't receive it (different user/origin)
      expect(bc1Spy.mock.calls.length).toBe(1);

      await tick(15);

      // Verify server dirty event was triggered for client2
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);

      // Client 2 sees the change via server
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("realTime=false - no automatic sync across users, verify manual sync", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: true, // Doesn't matter, different users
      });
      const { client: client2 } = createClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      // Client 1 creates document
      const doc1 = await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      // Wait for client1 to sync to server
      await tick(200);

      // Client 2 loads document
      const doc2 = await getDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      // Wait for client2 to sync and load the document
      await tick(200);

      // Verify doc2 loaded correctly (should have no children yet)
      let countBefore = 0;
      doc2.root.children().forEach(() => countBefore++);
      expect(countBefore).toBe(0);

      // Spy on mechanisms
      const dirtySpy2 = spyOnDirtyEvent(client2);
      dirtySpy2.mockClear();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick(15);

      // No server dirty event (realTime: false)
      expect(dirtySpy2.mock.calls.length).toBe(0);

      // Client 2 should NOT see the change automatically
      let countNoSync = 0;
      doc2.root.children().forEach(() => countNoSync++);
      expect(countNoSync).toBe(0);

      // Wait for client1 to push changes to server
      await tick(200);

      // Client 2 manually triggers sync (pull from server)
      await client2.onLocalOperations({
        docId,
        operations: [],
      });

      // Wait for sync to complete
      await tick(200);

      // After manual sync, Client2 should see the changes
      let countAfterManualSync = 0;
      doc2.root.children().forEach(() => countAfterManualSync++);
      expect(countAfterManualSync).toBe(1);
    });
  });

  describe("Edge Cases", () => {
    test("_sendMessage guard works without errors when BroadcastChannel disabled", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client } = createClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      // Create document
      const doc = await getDoc(client, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      // Making a change should not throw even though BroadcastChannel is disabled
      expect(() => {
        const child = doc.createNode(ChildNode);
        doc.root.append(child);
      }).not.toThrow();
    });

    test("documents are automatically subscribed when loaded with realTime: true", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId1);
      const { client: client2 } = createClient(userId2);

      // Client 1 creates document
      await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(200);

      // Client 2 loads document
      await getDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      // Wait for subscriptions to complete
      await tick(200);

      // Both should be subscribed
      const serverSync1 = client1["_serverSync"];
      const serverSync2 = client2["_serverSync"];

      expect(serverSync1!["_subscribedDocs"].has(docId)).toBe(true);
      expect(serverSync2!["_subscribedDocs"].has(docId)).toBe(true);
    });

    test("documents are NOT subscribed when loaded with realTime: false", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createClient(userId1, undefined, {
        realTime: false,
      });
      const { client: client2 } = createClient(userId2, undefined, {
        realTime: false,
      });

      // Client 1 creates document
      await getDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick(200);

      // Client 2 loads document
      await getDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      // Neither should be subscribed
      const serverSync1 = client1["_serverSync"];
      const serverSync2 = client2["_serverSync"];

      expect(serverSync1!["_subscribedDocs"].has(docId)).toBe(false);
      expect(serverSync2!["_subscribedDocs"].has(docId)).toBe(false);
    });
  });
});
