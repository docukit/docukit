import { describe, test, expect, vi } from "vitest";
import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode, type Doc, type JsonDoc, type Operations } from "docnode";
import { ulid } from "ulid";

// Mock socket.io-client to avoid real connections
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

// ============================================================================
// Test Setup
// ============================================================================

const TestNode = defineNode({ type: "test", state: {} });
const ChildNode = defineNode({ type: "child", state: {} });

const createDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

// Generate unique userIds for test isolation
let testUserCounter = 0;
const generateTestUserId = () =>
  `serversync-test-${Date.now()}-${++testUserCounter}`;

// Generate unique docIds (must be lowercase ULIDs)
const generateDocId = () => ulid().toLowerCase();

// Create test operations - the content doesn't matter for sync tests
const ops = (data?: Record<string, string>): Operations =>
  [[], data ? { testNode: data } : {}] as Operations;

// Mock API class
const createMockApi = () => ({
  request: vi.fn().mockResolvedValue({
    docId: "test-doc",
    operations: [],
    serializedDoc: {},
    clock: 1,
  }),
});

type MockApi = ReturnType<typeof createMockApi>;

/**
 * Helper to create a DocSyncClient and access its internal ServerSync.
 * Returns both the ServerSync and the provider (for direct IDB operations in tests).
 */
const createServerSync = async (mockApi: MockApi) => {
  const docBinding = createDocBinding();
  const userId = generateTestUserId();

  const config: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: "ws://localhost:8081",
      auth: { getToken: async () => "test-token" },
    },
    docBinding,
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({ userId, secret: "test-secret" }),
    },
  };

  const client = new DocSyncClient(config);

  // Force lazy initialization to create the provider and ServerSync
  const local = await client["_getLocal"]?.();
  if (!local) throw new Error("Local not initialized");

  const provider = local.provider as IndexedDBProvider<JsonDoc, Operations>;

  // Access the internal ServerSync and replace its API with our mock
  const serverSync = client["_serverSync"];
  if (!serverSync) throw new Error("ServerSync not initialized");
  serverSync["_api"] = mockApi;

  return { serverSync, docBinding, provider, client };
};

// Helper to wait for async operations
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// ServerSync Tests
// ============================================================================

describe("ServerSync", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // saveRemote
  // ──────────────────────────────────────────────────────────────────────────

  describe("saveRemote", () => {
    test("should call _doPush when status is idle", async () => {
      const mockApi = createMockApi();
      const { serverSync, provider } = await createServerSync(mockApi);
      const doPushSpy = vi.spyOn(
        serverSync,
        "_doPush" as keyof typeof serverSync,
      );
      const docId = generateDocId();

      // Add an operation to push
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: [[], {}] }),
      );

      serverSync.saveRemote({ docId });

      expect(doPushSpy).toHaveBeenCalledWith({ docId });
    });

    test("should set status to pushing-with-pending when called during a push", async () => {
      const mockApi = createMockApi();
      // Make API slow to simulate in-progress push
      mockApi.request.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
      );
      const { serverSync, provider } = await createServerSync(mockApi);
      const docId = generateDocId();

      // Add operations
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: [[], {}] }),
      );

      // Start first push
      serverSync.saveRemote({ docId });
      await tick(1); // Let push start

      // Second call during push
      serverSync.saveRemote({ docId });

      // Check status is pushing-with-pending
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );
    });

    test("should allow concurrent pushes for different docIds", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 20)),
      );
      const { serverSync, provider } = await createServerSync(mockApi);
      const docId1 = generateDocId();
      const docId2 = generateDocId();

      // Add operations for two different docs
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveOperations({ docId: docId1, operations: [[], {}] });
        await ctx.saveOperations({ docId: docId2, operations: [[], {}] });
      });

      // Start pushes for both docs
      serverSync.saveRemote({ docId: docId1 });
      serverSync.saveRemote({ docId: docId2 });
      await tick(1);

      // Both should be pushing (not blocking each other)
      expect(serverSync["_pushStatusByDocId"].get(docId1)).toBe("pushing");
      expect(serverSync["_pushStatusByDocId"].get(docId2)).toBe("pushing");
    });

    test("should be idempotent for same docId during push", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
      );
      const { serverSync, provider } = await createServerSync(mockApi);
      const doPushSpy = vi.spyOn(
        serverSync,
        "_doPush" as keyof typeof serverSync,
      );
      const docId = generateDocId();

      // Add operation
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: [[], {}] }),
      );

      // Call saveRemote multiple times rapidly
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });
      await tick(1);

      // _doPush should only be called once initially
      expect(doPushSpy).toHaveBeenCalledTimes(1);
      // Status should be pushing-with-pending (not multiple pushes)
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );
    });

    test("should handle rapid successive calls correctly", async () => {
      const mockApi = createMockApi();
      let callCount = 0;
      const docId = generateDocId();
      mockApi.request.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          docId,
          operations: [],
          serializedDoc: {},
          clock: callCount,
        });
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      // Save a serialized doc first (needed for consolidation)
      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        }),
      );

      // Add operation and push
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: [[], {}] }),
      );
      serverSync.saveRemote({ docId });

      // Add more operations while pushing
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: [[], {}] }),
      );
      serverSync.saveRemote({ docId });

      // Wait for all pushes to complete
      await tick(50);

      // Should have made 2 API calls (initial + retry)
      expect(mockApi.request).toHaveBeenCalledTimes(2);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Basic Flow
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Basic Flow", () => {
    test("should get operations from provider", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      // Save serialized doc and operations
      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({
          docId,
          operations: [[], { nodeId: { key: "value" } }],
        });
      });

      serverSync.saveRemote({ docId });
      await tick(20);

      // API should receive the operations
      expect(mockApi.request).toHaveBeenCalledWith("sync-operations", {
        clock: 0,
        docId,
        operations: [[[], { nodeId: { key: "value" } }]],
      });
    });

    test("should set status to pushing at start", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      let statusDuringPush: string | undefined;
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      mockApi.request.mockImplementation(async () => {
        // Capture status during the push
        statusDuringPush = serverSync["_pushStatusByDocId"].get(docId);
        return { docId, operations: [], serializedDoc: {}, clock: 1 };
      });

      // Setup doc
      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(20);

      expect(statusDuringPush).toBe("pushing");
    });

    test("should send operations to API via sync-operations endpoint", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      // Setup doc with operations
      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(20);

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          operations: expect.arrayContaining([]),
        }),
      );
    });

    test("should include docId and clock in request", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(20);

      expect(mockApi.request).toHaveBeenCalledWith("sync-operations", {
        clock: 0,
        docId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        operations: expect.arrayContaining([]),
      });
    });

    test("should handle empty operations list (no-op)", async () => {
      const mockApi = createMockApi();
      const { serverSync } = await createServerSync(mockApi);
      const docId = generateDocId();

      // No operations saved
      serverSync.saveRemote({ docId });
      await tick(20);

      // API should not be called if no operations
      expect(mockApi.request).not.toHaveBeenCalled();
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Success Path
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Success Path", () => {
    test("should delete operations after successful push", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      // Verify operations exist
      const opsBefore = await provider.transaction("readonly", (ctx) =>
        ctx.getOperations({ docId }),
      );
      expect(opsBefore).toHaveLength(2);

      serverSync.saveRemote({ docId });
      await tick(30);

      // Verify operations deleted
      const opsAfter = await provider.transaction("readonly", (ctx) =>
        ctx.getOperations({ docId }),
      );
      expect(opsAfter).toHaveLength(0);
    });

    test("should delete exact count of pushed operations", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      // Make API slow so we can add more ops during push
      mockApi.request.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ docId, operations: [], serializedDoc: {}, clock: 1 }),
              30,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: ops({ batch: "1" }) });
        await ctx.saveOperations({ docId, operations: ops({ batch: "1" }) });
      });

      serverSync.saveRemote({ docId });
      await tick(5);

      // Add more operations while pushing
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveOperations({ docId, operations: ops({ batch: "2" }) });
      });
      serverSync.saveRemote({ docId }); // Mark as pending

      await tick(100);

      // All operations should eventually be pushed
      const opsAfter = await provider.transaction("readonly", (ctx) =>
        ctx.getOperations({ docId }),
      );
      expect(opsAfter).toHaveLength(0);
      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should consolidate operations into serialized doc after push", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      const { doc } = docBinding.new("test", docId);
      // Add a child node to create a real operation
      const child = doc.createNode(ChildNode);
      doc.root.append(child);

      await provider.transaction("readwrite", async (ctx) => {
        // Save the initial doc state
        const initialDoc = docBinding.new("test", docId).doc;
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
        // Save the operations that add the child
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(30);

      // Verify serialized doc was updated (clock incremented)
      const stored = await provider.transaction("readonly", (ctx) =>
        ctx.getSerializedDoc(docId),
      );
      expect(stored?.clock).toBe(1);
    });

    test("should increment clock after consolidation", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 5, // Start with clock 5
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(30);

      const stored = await provider.transaction("readonly", (ctx) =>
        ctx.getSerializedDoc(docId),
      );
      expect(stored?.clock).toBe(6); // Clock incremented
    });

    test("should set status to idle after successful push", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(30);

      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Retry Logic
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Retry Logic", () => {
    test("should retry if more operations were queued during push (pushing-with-pending)", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      mockApi.request.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ docId, operations: [], serializedDoc: {}, clock: 1 }),
              20,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(5);

      // Add more operations and trigger saveRemote during push
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: [[], {}] }),
      );
      serverSync.saveRemote({ docId });

      // Wait for both pushes
      await tick(100);

      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should retry on API failure", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      let callCount = 0;
      mockApi.request.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          docId,
          operations: [],
          serializedDoc: {},
          clock: 1,
        });
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(50);

      // Should have retried after failure
      expect(mockApi.request).toHaveBeenCalledTimes(2);
      // And eventually succeeded
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should set status to idle before retry", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      const statusHistory: (string | undefined)[] = [];
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      mockApi.request.mockImplementation(() => {
        statusHistory.push(serverSync["_pushStatusByDocId"].get(docId));
        if (statusHistory.length === 1) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          docId,
          operations: [],
          serializedDoc: {},
          clock: 1,
        });
      });

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      serverSync.saveRemote({ docId });
      await tick(50);

      // Both calls should see "pushing" status
      expect(statusHistory).toStrictEqual(["pushing", "pushing"]);
    });

    test("should handle retry with new operations", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      const receivedOperations: unknown[] = [];
      mockApi.request.mockImplementation(
        (_: unknown, payload: { operations: unknown }) => {
          receivedOperations.push(payload.operations);
          return Promise.resolve({
            docId,
            operations: [],
            serializedDoc: {},
            clock: receivedOperations.length,
          });
        },
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: ops({ op: "1" }) });
      });

      serverSync.saveRemote({ docId });
      await tick(5);

      // Add new operations during push
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: ops({ op: "2" }) }),
      );
      serverSync.saveRemote({ docId });

      await tick(50);

      expect(receivedOperations).toHaveLength(2);
      expect(receivedOperations[0]).toStrictEqual([ops({ op: "1" })]);
      expect(receivedOperations[1]).toStrictEqual([ops({ op: "2" })]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Concurrency
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Concurrency", () => {
    test("should not push same doc twice simultaneously", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      mockApi.request.mockImplementation(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await tick(20);
        concurrentCalls--;
        return { docId, operations: [], serializedDoc: {}, clock: 1 };
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      // Try to trigger multiple simultaneous pushes
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });

      await tick(100);

      // Should never have more than 1 concurrent call for same doc
      expect(maxConcurrent).toBe(1);
    });

    test("should queue operations that arrive during push", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      mockApi.request.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ docId, operations: [], serializedDoc: {}, clock: 1 }),
              30,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: ops({ first: "true" }) });
      });

      serverSync.saveRemote({ docId });
      await tick(5);

      // Queue more operations during push
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: ops({ second: "true" }) }),
      );
      serverSync.saveRemote({ docId });
      await provider.transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId, operations: ops({ third: "true" }) }),
      );
      serverSync.saveRemote({ docId });

      await tick(100);

      // All operations should eventually be pushed
      expect(mockApi.request).toHaveBeenCalledTimes(2);
      const secondCall = mockApi.request.mock.calls[1] as
        | [string, { operations: unknown[] }]
        | undefined;
      expect(secondCall?.[1].operations).toHaveLength(2); // second and third batched
    });

    test("should handle interleaved operations from different docs", async () => {
      const mockApi = createMockApi();
      const docId1 = generateDocId();
      const docId2 = generateDocId();
      const callOrder: string[] = [];
      mockApi.request.mockImplementation(
        async (_: unknown, payload: { docId: string }) => {
          callOrder.push(payload.docId);
          await tick(10);
          return {
            docId: payload.docId,
            operations: [],
            serializedDoc: {},
            clock: 1,
          };
        },
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      // Setup two docs
      for (const docId of [docId1, docId2]) {
        const { doc } = docBinding.new("test", docId);
        await provider.transaction("readwrite", async (ctx) => {
          await ctx.saveSerializedDoc({
            serializedDoc: docBinding.serialize(doc),
            docId,
            clock: 0,
          });
          await ctx.saveOperations({ docId, operations: [[], {}] });
        });
      }

      // Push both docs simultaneously
      serverSync.saveRemote({ docId: docId1 });
      serverSync.saveRemote({ docId: docId2 });

      await tick(50);

      // Both docs should have been pushed
      expect(callOrder).toContain(docId1);
      expect(callOrder).toContain(docId2);
      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should handle status changes during async operations", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      mockApi.request.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ docId, operations: [], serializedDoc: {}, clock: 1 }),
              20,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [[], {}] });
      });

      // Start push
      serverSync.saveRemote({ docId });
      await tick(5);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("pushing");

      // Trigger pending
      serverSync.saveRemote({ docId });
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );

      // Wait for completion
      await tick(100);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });
});
