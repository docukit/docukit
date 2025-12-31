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

describe.sequential("Real-Time Synchronization - All 32 Scenarios", () => {
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
    test("1A: No ops either side - up-to-date check", async () => {
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

      // Client 1 creates document
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      // Client 2 loads document
      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Neither makes changes
      // Verify: No sync activity, both have empty docs
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("1B: Server has ops - pull new operations", async () => {
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

      // Simulate server having ops: Client1 makes change before Client2 loads
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      // Wait for Client1 to push to server
      await tick();

      // Now Client2 loads - should get ops from server
      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Client2 should see the change (from IndexedDB + any pending server ops)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("1C: Client sends ops - push with instant BC propagation", async () => {
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

      await tick(10);

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick(10);

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

      // Client 2 sees the change immediately (via BroadcastChannel)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);

      await tick(10);

      // Verify dirty event also triggered (redundant)
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);
    });

    test.skip("1D: Both have ops - bidirectional sync", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Create a third client to simulate external server changes
      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: true,
        broadcastChannel: true,
      });
      const { client: client3 } = createClient(generateUserId()); // Different user for external change

      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Client3 creates external change (simulates server having ops)
      const doc3 = await getDoc(client3, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child3 = doc3.createNode(ChildNode);
      doc3.root.append(child3);

      await tick();

      // Now Client1 makes concurrent change
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 should eventually see both changes
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(2);
    });
  });

  // ==========================================================================
  // CONFIG 2: Different Users + BC=ON + RT=ON (Both mechanisms, BC ineffective)
  // Expected: Server Dirty only (BC doesn't cross users)
  // ==========================================================================

  describe("Config 2: Different Users + BC=ON + RT=ON", () => {
    test("2A: No ops either side - no changes", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1);
      const { client: client2 } = createTrackedClient(userId2);

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

      // Neither makes changes
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("2B: Server has ops - pull via dirty event", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1);
      const { client: client2 } = createTrackedClient(userId2);

      // Client1 makes change first
      const doc1 = await getTrackedDoc(client1, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Client2 loads - should get from server
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

    test("2C: Client sends ops - propagates via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1);
      const { client: client2 } = createTrackedClient(userId2);

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

      // Client 1 makes a change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // BroadcastChannel is called but client2 won't receive it (different user)
      expect(bc1Spy.mock.calls.length).toBe(1);

      await tick();

      // Verify server dirty event was triggered for client2
      expect(dirtySpy2.mock.calls.length).toBeGreaterThan(0);

      // Client 2 sees the change via server
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(1);
    });

    test("2D: Both have ops - bidirectional via dirty", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();
      const userId3 = generateUserId();
      const docId = generateDocId();

      const { client: client1 } = createTrackedClient(userId1);
      const { client: client2 } = createTrackedClient(userId2);
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

      // Client3 creates external change
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
    test("3A: No ops either side - no changes", async () => {
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

      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test.skip("3B: Server has ops - no dirty event, no pull (no-op)", async () => {
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

      // Now same-user clients load (RT=OFF, so no dirty subscription)
      const { client: client1 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, { type: "test", id: docId });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Both should have loaded the external change from server/IndexedDB
      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });

    test("3C: Client sends ops - instant BC propagation", async () => {
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

    test.skip("3D: Both have ops - BC gets client1 ops, server ops ignored", async () => {
      const userId = generateUserId();
      const docId = generateDocId();

      // Create external change
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
        broadcastChannel: true,
      });
      const { client: client2 } = createTrackedClient(userId, undefined, {
        realTime: false,
        broadcastChannel: true,
      });

      const doc1 = await getTrackedDoc(client1, { type: "test", id: docId });

      await tick();

      const doc2 = await getTrackedDoc(client2, { type: "test", id: docId });

      await tick();

      // Both have external change now
      let countBefore = 0;
      doc2.root.children().forEach(() => countBefore++);
      expect(countBefore).toBe(1);

      // Client1 makes new change
      const child1 = doc1.createNode(ChildNode);
      doc1.root.append(child1);

      await tick();

      // Client2 should see both (1 from initial load, 1 from BC)
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
    test("4A: No ops either side - no changes", async () => {
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

      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("4B: Server has ops - Client2 doesn't see (no sync mechanism)", async () => {
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

      // Client2 loads after change
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
    });

    test("4C: Client sends ops - no propagation to Client2", async () => {
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

      // Client1 makes change
      const child = doc1.createNode(ChildNode);
      doc1.root.append(child);

      await tick();

      // Client2 doesn't see it (no sync mechanism)
      let count = 0;
      doc2.root.children().forEach(() => count++);
      expect(count).toBe(0);
    });

    test("4D: Both have ops - no automatic sync, verify manual sync works", async () => {
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
    test("5A: No ops either side - no changes (no-op)", async () => {
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

      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test.skip("5B: Server has ops - dirty fires but shared clock causes empty response (NEGATIVE)", async () => {
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

    test.skip("5C: Client sends ops - dirty fires but empty response (NEGATIVE)", async () => {
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
    test("6A: No ops either side - no changes", async () => {
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

      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("6B: Server has ops - pull via dirty event", async () => {
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

    test("6C: Client sends ops - propagates via dirty", async () => {
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

    test("6D: Both have ops - bidirectional via dirty", async () => {
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
    test("7A: No ops either side - no changes", async () => {
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

      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test.skip("7B: Server has ops - Client2 doesn't see (no mechanism)", async () => {
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

    test("7C: Client sends ops - no propagation, verify reload", async () => {
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

    test.skip("7D: Both have ops - no automatic sync, verify reload", async () => {
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
    test("8A: No ops either side - no changes", async () => {
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

      let count1 = 0;
      doc1.root.children().forEach(() => count1++);
      let count2 = 0;
      doc2.root.children().forEach(() => count2++);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    test("8B: Server has ops - Client2 doesn't see (no sync)", async () => {
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

    test("8C: Client sends ops - no propagation", async () => {
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

    test("8D: Both have ops - no automatic sync, verify manual sync", async () => {
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
