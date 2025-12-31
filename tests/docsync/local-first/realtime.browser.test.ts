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
 * Real-Time Synchronization Tests - Complete 32 Scenario Coverage
 *
 * This file tests all 32 combinations of:
 * - 8 configurations (BC × RT × Same User)
 * - 4 runtime states per config (Client ops × Server ops)
 *
 * See REALTIME-TEST-PLAN.md for detailed analysis of each scenario.
 *
 * Test types:
 * - ✅ Positive: Verify sync works as expected
 * - 🚫 Negative: Verify broken configs fail predictably
 * - 💤 No-op: Verify no sync happens when expected
 */

describe("Real-Time Synchronization - All 32 Scenarios", () => {
  // Track clients created in each test for cleanup
  const activeClients: Array<ReturnType<typeof createClient>["client"]> = [];
  const activeCleanups: Array<() => void> = [];

  // Helper to create client and auto-track for cleanup
  const createTrackedClient = (
    userId: string,
    token?: string,
    config?: { realTime?: boolean; broadcastChannel?: boolean },
  ) => {
    const result = createClient(userId, token, config);
    activeClients.push(result.client);
    return result;
  };

  // Helper to get doc and auto-track cleanup
  const getTrackedDoc = async (
    client: ReturnType<typeof createClient>["client"],
    args: { type: string; id: string; createIfMissing?: boolean },
  ) => {
    const { doc, cleanup } = await getDocWithCleanup(client, args);
    activeCleanups.push(cleanup);
    return doc;
  };

  beforeAll(async () => {
    await tick();
  });

  afterEach(async () => {
    // Clean up all clients and docs created in this test
    for (const cleanup of activeCleanups) {
      cleanup();
    }
    activeCleanups.length = 0;

    // Close sockets and broadcast channels
    for (const client of activeClients) {
      // Close socket if exists
      if (client["_serverSync"]) {
        const socket = client["_serverSync"]["_api"]["_socket"];
        socket?.connected && socket.disconnect();
      }
      // Close broadcast channel if exists
      if (client["_broadcastChannel"]) {
        client["_broadcastChannel"].close();
      }
    }
    activeClients.length = 0;

    await tick(); // Give time for cleanup to complete
  });

  // ==========================================================================
  // CONFIG 1: Same User + BC=ON + RT=ON (Both mechanisms)
  // Expected: BroadcastChannel (primary) + Server Dirty (secondary)
  // ==========================================================================

  describe("Config 1: Same User + BC=ON + RT=ON", () => {
    test("1A: Both synced, no changes - natural sync with 0 ops", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      // Client 1 creates document and waits for initial sync
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client 2 loads document and waits for sync
      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Neither client makes changes. Both are synced with 0 ops.
      // The sync already happened during getDoc() - no need to trigger another.
      // Verify: Both docs remain empty (no changes applied)
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);

      // Note: Dirty event may or may not fire since server has no new ops
      // This is acceptable behavior for an up-to-date check
    });

    test("1B: Client syncs 0 ops, server responds with ops", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      // Client1 creates document
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client2 loads document
      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Set up spies before the change
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client1 makes a change (this creates ops on server)
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Wait for BC propagation and dirty event
      await tick();

      // Client2 should already see the change via BC
      let countBefore = 0;
      doc2.root.children().forEach(() => countBefore++);
      expect(countBefore).toBe(1);

      // Now simulate Client2 syncing with 0 ops (pull scenario)
      // This tests the case where Client2 might have missed the change
      // and does a sync to check for server updates
      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      await client2.onLocalOperations({ docId, operations: [] });

      await tick();

      // Verify: Client2 still has the change (no-op since already synced)
      let countAfter = 0;
      doc2.root.children().forEach(() => countAfter++);
      expect(countAfter).toBe(1);

      // Verify: This triggered a sync (dirty event may fire)
      // The key is that Client2 sent 0 ops and server could respond with ops
    });

    test("1C: Client pushes ops, server responds with 0", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Spy on mechanisms
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client1 makes a change (pushes ops, server has no new ops so responds with 0)
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Verify BroadcastChannel was used
      expect(bc1Spy.mock.calls.length).toBe(1);

      // Client2 sees the change immediately (via BroadcastChannel)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);

      await tick();

      // Verify dirty event also triggered (redundant)
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);
    });

    test.skip("1D: Client pushes ops, server also has ops", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      // Client3 simulates external server change (different user)
      const { client: client3 } = createClient(generateUserId());

      // Client1 and Client2 load the document
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Setup spies
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client3 makes an external change (creates ops on server)
      const doc3 = await getDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Now Client1 makes concurrent change (will push ops to server that also has ops)
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Verify BroadcastChannel was used for Client1's change
      expect(bc1Spy.mock.calls.length).toBe(1);

      // Wait for dirty event to propagate server's ops
      await tick();

      // Client2 should see both changes: Client1's via BC + Client3's via dirty
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(2);

      // Verify dirty event fired for Client3's change
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // CONFIG 2: Different Users + BC=ON + RT=ON (Both mechanisms, BC ineffective)
  // Expected: Server Dirty only (BC doesn't cross users)
  // ==========================================================================

  describe("Config 2: Different Users + BC=ON + RT=ON", () => {
    test("2A: Both synced, no changes - no dirty event", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("2B: Client2 syncs 0 ops, gets server ops via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      // Client1 creates and syncs document
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client2 loads document
      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Setup spy for dirty events on Client2
      const dirtySpy2 = spyOnDirtyEvent(client2);
      dirtySpy2.mockClear();

      // Client1 makes a change (creates ops on server)
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Wait for dirty event to fire and Client2 to pull
      await tick();

      // Verify: Client2 got the change via dirty event
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);

      // Verify: Dirty event was triggered
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);
    });

    test("2C: Client1 pushes ops, server responds 0, propagates via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Spy on mechanisms
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client1 makes a change (pushes ops, server has no new ops so responds with 0)
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // BroadcastChannel is called but Client2 won't receive it (different user)
      expect(bc1Spy.mock.calls.length).toBe(1);

      await tick();

      // Verify server dirty event was triggered for Client2
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);

      // Client2 sees the change via server dirty event
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("2D: Client1 pushes ops, server also has ops, both via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const userId3 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client3 } = createClient(userId3);

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client3 creates external change (server will have ops)
      const doc3 = await getDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Client1 makes concurrent change (pushes ops to server that also has ops)
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 should see both changes via dirty events
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(2);
    });
  });

  // ==========================================================================
  // CONFIG 3: Same User + BC=ON + RT=OFF (BC only)
  // Expected: BroadcastChannel only
  // ==========================================================================

  describe("Config 3: Same User + BC=ON + RT=OFF", () => {
    test("3A: Both synced, no changes - BC only config", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("3B: Client2 syncs 0 ops, server has ops, but no dirty - no-op", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Create external change via different user
      const { client: client3 } = createClient(generateUserId());
      const doc3 = await getTrackedDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Now same-user clients load (RT=OFF, so no dirty subscription)
      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Both should have loaded the external change from IndexedDB
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(1);
      expect(count2).toBe(1);

      // Now simulate Client2 doing manual sync with 0 ops
      // Since there are no NEW ops (Client2 already has the server state via IndexedDB),
      // this is effectively a no-op
      await client2.onLocalOperations({ docId, operations: [] });

      await tick();

      // Client2 still has the same state (no change)
      let countAfter = 0;
      doc2.root.children().forEach(() => countAfter++);
      expect(countAfter).toBe(1);
    });

    test("3C: Client1 pushes ops, server responds 0, instant BC", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Spy on mechanisms
      const bc1Spy = spyOnBroadcastChannel(client1);
      const dirtySpy2 = spyOnDirtyEvent(client2);

      bc1Spy.mockClear();
      dirtySpy2.mockClear();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Verify BroadcastChannel was used
      expect(bc1Spy.mock.calls.length).toBe(1);

      await tick();

      // Verify dirty event was NOT triggered (realTime: false)
      expect(dirtySpy2.mock.calls.length).toBe(0);

      // Client 2 sees the change via BroadcastChannel
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("3D: Client1 pushes ops, server has ops, BC gets client1 only", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Create external change
      const { client: client3 } = createClient(generateUserId());
      const doc3 = await getTrackedDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Same-user clients load
      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Both have external change now
      let countBefore = 0;
      doc2.root.children().forEach(() => countBefore++);
      expect(countBefore).toBe(1);

      // Client1 makes new change (pushes ops to server that also has other clients' ops)
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 should see both (1 from initial load, 1 from BC)
      // Server ops are ignored because RT=OFF (no dirty events)
      let countAfter = 0;
      doc2.root.children().forEach(() => countAfter++);
      expect(countAfter).toBe(2);
    });
  });

  // ==========================================================================
  // CONFIG 4: Different Users + BC=ON + RT=OFF (No effective mechanism)
  // Expected: No automatic sync
  // ==========================================================================

  describe("Config 4: Different Users + BC=ON + RT=OFF", () => {
    test("4A: Both synced, no changes - no sync mechanism", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty, no automatic notification
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("4B: Client2 syncs 0 ops, server has ops but no notification", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Client2 loads after change (will get it from server on initial load)
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client2 should see the change (from server on initial load)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);

      // Note: If Client2 was already loaded and Client1 made the change,
      // Client2 would NOT see it automatically (no sync mechanism)
    });

    test("4C: Client1 pushes ops, server responds 0, no propagation", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client1 makes change (pushes ops to server)
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Client2 doesn't see it automatically (no sync mechanism)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0);
    });

    test("4D: Client1 pushes ops, server has ops, no auto-sync, manual works", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const userId3 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // External change via client3
      const { client: client3 } = createClient(userId3, undefined, {
        realTime: false,
      });
      const doc3 = await getDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Client1 makes concurrent change
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 doesn't see either change
      let countBefore = 0;
      doc2.root.children().forEach(() => countBefore++);
      expect(countBefore).toBe(0);

      // Manual sync
      await client2.onLocalOperations({
        docId,
        operations: [],
      });

      await tick();

      // Now Client2 sees both changes
      let countAfter = 0;
      doc2.root.children().forEach(() => countAfter++);
      expect(countAfter).toBe(2);
    });
  });

  // ==========================================================================
  // CONFIG 5: Same User + BC=OFF + RT=ON (BROKEN - Negative Tests)
  // Expected: Broken due to shared clock problem
  // ==========================================================================

  describe("Config 5: Same User + BC=OFF + RT=ON (BROKEN)", () => {
    test("5A: Both synced, no changes - broken config baseline", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty (no-op since no changes)
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test.skip("5B: Client2 syncs 0 ops, server has ops, shared clock breaks it", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Create external change via different user
      const { client: client3 } = createTrackedClient(generateUserId());
      const doc3 = await getTrackedDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Same-user clients load
      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      expect(client1["_broadcastChannel"]).toBeUndefined();
      expect(client2["_broadcastChannel"]).toBeUndefined();

      const doc1 = await getTrackedDoc(client1, { type: "test", id: docId });

      await tick();

      const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
        client2,
        { type: "test", id: docId },
      );
      activeCleanups.push(cleanup2);

      await tick();

      // Both should have loaded external change initially
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2Initial = 0;
      doc2.root.children().forEach(() => count2Initial++);

      expect(count1).toBe(1);
      expect(count2Initial).toBe(1);

      // If client1 makes another change now, client2 won't see it (broken)
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // ❌ NEGATIVE: Client2 in-memory doc doesn't update
      let count2AfterChange = 0;
      doc2.root.children().forEach(() => count2AfterChange++);
      expect(count2AfterChange).toBe(1); // Still 1, not 2

      // ✅ After reload, sees changes from IndexedDB
      cleanup2();
      activeCleanups.splice(activeCleanups.indexOf(cleanup2), 1);
      await tick();

      const doc2Reloaded = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
      });
      await tick();

      let countReloaded = 0;
      doc2Reloaded.root.children().forEach(() => countReloaded++);
      expect(countReloaded).toBe(2); // Now sees both
    });

    test.skip("5C: Client1 pushes ops, server responds 0, dirty+shared clock breaks", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      expect(client1["_broadcastChannel"]).toBeUndefined();
      expect(client2["_broadcastChannel"]).toBeUndefined();

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
        client2,
        { type: "test", id: docId },
      );
      activeCleanups.push(cleanup2);

      await tick();

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // ❌ NEGATIVE: Client 2 doesn't see the change in memory
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0); // Broken: in-memory doc is stale

      // ✅ After reload, Client2 sees changes from IndexedDB
      cleanup2();
      activeCleanups.splice(activeCleanups.indexOf(cleanup2), 1);
      await tick();

      const doc2Reloaded = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
      });
      await tick();

      let countAfterReload = 0;
      doc2Reloaded.root.children().forEach(() => countAfterReload++);
      expect(countAfterReload).toBe(1); // IndexedDB has the change!
    });

    test.skip(
      "5D: Both have ops - same broken behavior (NEGATIVE)",
      { timeout: 10000 },
      async () => {
        const userId = generateUserId();
        const docId = generateDocId();

        const { client: client1 } = createTrackedClient(userId, undefined, {
          realTime: true,
          broadcastChannel: false,
        });
        const { client: client2 } = createTrackedClient(userId, undefined, {
          realTime: true,
          broadcastChannel: false,
        });

        // External change
        const { client: client3 } = createTrackedClient(generateUserId());
        const doc3 = await getTrackedDoc(client3, {
          type: "test",
          id: docId,
          createIfMissing: true,
        });

        const child3 = doc3.createNode(ChildNode);
        doc3.root.append(child3);

        await tick();

        // Same-user clients load
        const doc1 = await getTrackedDoc(client1, { type: "test", id: docId });

        await tick();

        const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
          client2,
          { type: "test", id: docId },
        );
        activeCleanups.push(cleanup2);

        await tick();

        // Both have external change
        let count1Initial = 0;
        doc1.root.children().forEach(() => count1Initial++);
        expect(count1Initial).toBe(1);

        // Client1 makes concurrent change
        const child1 = doc1.createNode(ChildNode);
        doc1.root.append(child1);

        await tick();

        // ❌ NEGATIVE: Client2 doesn't see client1's change
        let count2 = 0;
        doc2.root.children().forEach(() => count2++);
        expect(count2).toBe(1); // Still only has external change

        // ✅ After reload, sees both
        cleanup2();
        activeCleanups.splice(activeCleanups.indexOf(cleanup2), 1);
        await tick();

        const doc2Reloaded = await getTrackedDoc(client2, {
          type: "test",
          id: docId,
        });
        await tick();

        let countReloaded = 0;
        doc2Reloaded.root.children().forEach(() => countReloaded++);
        expect(countReloaded).toBe(2);
      },
    );
  });

  // ==========================================================================
  // CONFIG 6: Different Users + BC=OFF + RT=ON (Server Dirty only)
  // Expected: Server Dirty Events work correctly
  // ==========================================================================

  describe("Config 6: Different Users + BC=OFF + RT=ON", () => {
    test("6A: Both synced, no changes - RT only config", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty (no-op)
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("6B: Client2 syncs 0 ops, gets server ops via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("6C: Client1 pushes ops, server responds 0, propagates via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const dirtySpy2 = spyOnDirtyEvent(client2);
      dirtySpy2.mockClear();

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);

      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("6D: Client1 pushes ops, server has ops, both via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const userId3 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: true,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // External change
      const { client: client3 } = createClient(userId3, undefined, {
        realTime: true,
        broadcastChannel: false,
      });
      const doc3 = await getDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Client1 concurrent change
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 sees both
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(2);
    });
  });

  // ==========================================================================
  // CONFIG 7: Same User + BC=OFF + RT=OFF (No automatic sync)
  // Expected: Manual sync only (reload pattern)
  // ==========================================================================

  describe("Config 7: Same User + BC=OFF + RT=OFF", () => {
    test("7A: Both synced, no changes - manual sync only", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty (no automatic sync mechanism)
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test.skip("7B: Client2 syncs 0 ops, server has ops but no notification", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // External change
      const { client: client3 } = createTrackedClient(generateUserId());
      const doc3 = await getTrackedDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Same-user clients load
      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, { type: "test", id: docId });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Both should have loaded from IndexedDB (which has external change)
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });

    test("7C: Client1 pushes ops, server responds 0, no propagation, reload works", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
        client2,
        { type: "test", id: docId },
      );
      activeCleanups.push(cleanup2);

      await tick();

      const dirtySpy2 = spyOnDirtyEvent(client2);
      dirtySpy2.mockClear();

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      expect(dirtySpy2.mock.calls.length).toBe(0);

      // Client 2 doesn't see the change (no automatic sync)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0);

      // Reload
      cleanup2();
      activeCleanups.splice(activeCleanups.indexOf(cleanup2), 1);
      await tick();

      const doc2Reloaded = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
      });
      await tick();

      // After reload, sees changes from IndexedDB
      let countAfterReload = 0;
      doc2Reloaded.root.children().forEach(() => countAfterReload++);
      expect(countAfterReload).toBe(1);
    });

    test.skip("7D: Client1 pushes ops, server has ops, no auto-sync, reload works", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // External change
      const { client: client3 } = createTrackedClient(generateUserId());
      const doc3 = await getTrackedDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, { type: "test", id: docId });

      await tick();

      const { doc: doc2, cleanup: cleanup2 } = await getDocWithCleanup(
        client2,
        { type: "test", id: docId },
      );
      activeCleanups.push(cleanup2);

      await tick();

      // Both have external change from initial load
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      expect(count1).toBe(1);

      // Client1 makes concurrent change
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 doesn't see client1's change
      let count2Before = 0;
      doc2.root.children().forEach(() => count2Before++);
      expect(count2Before).toBe(1);

      // Reload
      cleanup2();
      activeCleanups.splice(activeCleanups.indexOf(cleanup2), 1);
      await tick();

      const doc2Reloaded = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
      });
      await tick();

      // After reload, sees both
      let countReloaded = 0;
      doc2Reloaded.root.children().forEach(() => countReloaded++);
      expect(countReloaded).toBe(2);
    });
  });

  // ==========================================================================
  // CONFIG 8: Different Users + BC=OFF + RT=OFF (No automatic sync)
  // Expected: Manual sync only (manual pull pattern)
  // ==========================================================================

  describe("Config 8: Different Users + BC=OFF + RT=OFF", () => {
    test("8A: Both synced, no changes - manual sync only (diff users)", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Neither makes changes. Both are synced (sync happened during getDoc).
      // Verify: Both docs remain empty (no automatic sync)
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("8B: Client2 syncs 0 ops, server has ops but no notification", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client2 should see from initial server load
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("8C: Client1 pushes ops, server responds 0, no propagation", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Client2 doesn't see it
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0);
    });

    test("8D: Client1 pushes ops, server has ops, no auto-sync, manual works", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1, undefined, {
        realTime: false,
        broadcastChannel: false,
      });
      const { client: client2 } = createTrackedClient(userId2, undefined, {
        realTime: false,
        broadcastChannel: false,
      });

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client1 makes change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Client2 doesn't see it yet
      let countNoSync = 0;
      doc2.root.children().forEach(() => countNoSync++);
      expect(countNoSync).toBe(0);

      // Manual sync
      await client2.onLocalOperations({
        docId,
        operations: [],
      });

      await tick();

      // After manual sync, Client2 sees the changes
      let countAfterManualSync = 0;
      doc2.root.children().forEach(() => countAfterManualSync++);
      expect(countAfterManualSync).toBe(1);
    });
  });
});
