import { describe, test, expect, vi } from "vitest";
import {
  createMockApi,
  createServerSync,
  generateDocId,
  setupDocWithOperations,
  saveOperations,
  getOperationsCount,
  getStoredClock,
  tick,
  ops,
  emptyOps,
  ChildNode,
} from "./utils.js";
import type { Operations } from "docnode";

// Mock socket.io-client to avoid real connections
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

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

      await saveOperations(provider, docId);
      serverSync.saveRemote({ docId });

      expect(doPushSpy).toHaveBeenCalledWith({ docId });
    });

    test("should set status to pushing-with-pending when called during a push", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((r) => setTimeout(r, 50)),
      );
      const { serverSync, provider } = await createServerSync(mockApi);
      const docId = generateDocId();

      await saveOperations(provider, docId);
      serverSync.saveRemote({ docId });
      await tick(1);
      serverSync.saveRemote({ docId });

      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );
    });

    test("should allow concurrent pushes for different docIds", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((r) => setTimeout(r, 20)),
      );
      const { serverSync, provider } = await createServerSync(mockApi);
      const docId1 = generateDocId();
      const docId2 = generateDocId();

      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveOperations({ docId: docId1, operations: [emptyOps()] });
        await ctx.saveOperations({ docId: docId2, operations: [emptyOps()] });
      });

      serverSync.saveRemote({ docId: docId1 });
      serverSync.saveRemote({ docId: docId2 });
      await tick(1);

      expect(serverSync["_pushStatusByDocId"].get(docId1)).toBe("pushing");
      expect(serverSync["_pushStatusByDocId"].get(docId2)).toBe("pushing");
    });

    test("should be idempotent for same docId during push", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((r) => setTimeout(r, 50)),
      );
      const { serverSync, provider } = await createServerSync(mockApi);
      const doPushSpy = vi.spyOn(
        serverSync,
        "_doPush" as keyof typeof serverSync,
      );
      const docId = generateDocId();

      await saveOperations(provider, docId);
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });
      await tick(1);

      expect(doPushSpy).toHaveBeenCalledTimes(1);
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
          serializedDoc: null,
          clock: callCount,
        });
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });

      await saveOperations(provider, docId);
      serverSync.saveRemote({ docId });

      await tick(50);

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

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({
          docId,
          operations: [],
        });
      });

      serverSync.saveRemote({ docId });
      await tick(20);

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
        statusDuringPush = serverSync["_pushStatusByDocId"].get(docId);
        return { docId, operations: [], serializedDoc: null, clock: 1 };
      });

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      await tick(20);

      expect(statusDuringPush).toBe("pushing");
    });

    test("should send operations to API via sync-operations endpoint", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      await tick(20);

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({ docId }),
      );
    });

    test("should include docId and clock in request", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      await tick(20);

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({ clock: 0, docId }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Client/Server Operation Combinations (2x2 matrix)
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Client/Server Operation Combinations", () => {
    test("should handle client sends operations + server returns no operations", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockResolvedValue({
        docId: "test-doc",
        operations: null,
        serializedDoc: null,
        clock: 1,
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ test: "data" })],
      });

      serverSync.saveRemote({ docId });
      await tick(30);

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [ops({ test: "data" })],
        }),
      );
      expect(await getOperationsCount(provider, docId)).toBe(0);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends operations + server returns operations", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();

      // Mock server operations using ops helper to avoid ID conflicts
      const serverOperations = [ops({ server: "op1" }), ops({ server: "op2" })];

      // Mock API to return server operations
      mockApi.request.mockResolvedValue({
        docId,
        operations: serverOperations,
        serializedDoc: null,
        clock: 1,
      });

      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ client: "op" })],
      });

      serverSync.saveRemote({ docId });
      await tick(30);

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [ops({ client: "op" })],
        }),
      );
      expect(await getOperationsCount(provider, docId)).toBe(0);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends no operations + server returns no operations (pull with no updates)", async () => {
      const mockApi = createMockApi();
      mockApi.request.mockResolvedValue({
        docId: "test-doc",
        operations: null,
        serializedDoc: null,
        clock: 1,
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      // Setup a document without pending operations (pure pull scenario)
      const { doc: initialDoc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
      });

      serverSync.saveRemote({ docId });
      await tick(20);

      // Should call API even with no local operations (this is a pull)
      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [],
        }),
      );
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends no operations + server returns operations (pull with updates)", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();

      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      // Create server operations by modifying a doc
      const { doc: serverDoc } = docBinding.new("test", docId);
      const serverChild1 = serverDoc.createNode(ChildNode);
      const serverChild2 = serverDoc.createNode(ChildNode);

      // Capture the operations generated by these changes
      const serverOperations: Operations[] = [];
      serverDoc.onChange((ev: { operations: Operations }) => {
        serverOperations.push(ev.operations);
        return () => {
          // Cleanup function (intentionally empty for test)
        };
      });

      serverDoc.root.append(serverChild1);
      serverDoc.root.append(serverChild2);

      // Mock API to return server operations
      mockApi.request.mockResolvedValue({
        docId,
        operations: serverOperations,
        serializedDoc: null,
        clock: 1,
      });

      // Setup a document without pending operations (pure pull scenario)
      const { doc: initialDoc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
      });

      // Trigger pull - client has no operations but wants server's updates
      serverSync.saveRemote({ docId });
      await tick(30);

      // Should call API with empty operations (this is a pull)
      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [],
        }),
      );

      // Verify server operations were applied to stored document
      const storedDoc = await provider.transaction("readonly", async (ctx) => {
        const stored = await ctx.getSerializedDoc(docId);
        if (!stored) return null;
        return docBinding.deserialize(stored.serializedDoc);
      });

      if (!storedDoc) throw new Error("Stored doc not found");
      let storedChildren = 0;
      storedDoc.root.children().forEach(() => storedChildren++);
      // Should have the 2 server children
      expect(storedChildren).toBe(2);
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

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [emptyOps(), emptyOps()],
      });

      expect(await getOperationsCount(provider, docId)).toBe(2);

      serverSync.saveRemote({ docId });
      await tick(30);

      expect(await getOperationsCount(provider, docId)).toBe(0);
    });

    test("should delete exact count of pushed operations", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      mockApi.request.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  docId,
                  operations: [],
                  serializedDoc: null,
                  clock: 1,
                }),
              30,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ batch: "1" }), ops({ batch: "1" })],
      });

      serverSync.saveRemote({ docId });
      await tick(5);

      await saveOperations(provider, docId, [ops({ batch: "2" })]);
      serverSync.saveRemote({ docId });

      await tick(100);

      expect(await getOperationsCount(provider, docId)).toBe(0);
      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should consolidate operations into serialized doc after push", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      const { doc } = docBinding.new("test", docId);
      const child = doc.createNode(ChildNode);
      doc.root.append(child);

      await provider.transaction("readwrite", async (ctx) => {
        const initialDoc = docBinding.new("test", docId).doc;
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [emptyOps()] });
      });

      serverSync.saveRemote({ docId });
      await tick(30);

      expect(await getStoredClock(provider, docId)).toBe(1);
    });

    test("should increment clock after consolidation", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId, { clock: 5 });
      serverSync.saveRemote({ docId });
      await tick(30);

      expect(await getStoredClock(provider, docId)).toBe(6);
    });

    test("should set status to idle after successful push", async () => {
      const mockApi = createMockApi();
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId);
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
                resolve({
                  docId,
                  operations: [],
                  serializedDoc: null,
                  clock: 1,
                }),
              20,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      await tick(5);

      await saveOperations(provider, docId);
      serverSync.saveRemote({ docId });

      await tick(100);

      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should retry on API failure", async () => {
      const mockApi = createMockApi();
      const docId = generateDocId();
      let callCount = 0;
      mockApi.request.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("Network error"));
        return Promise.resolve({
          docId,
          operations: [],
          serializedDoc: null,
          clock: 1,
        });
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      await tick(50);

      expect(mockApi.request).toHaveBeenCalledTimes(2);
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
        if (statusHistory.length === 1)
          return Promise.reject(new Error("Network error"));
        return Promise.resolve({
          docId,
          operations: [],
          serializedDoc: null,
          clock: 1,
        });
      });

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      await tick(50);

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
            serializedDoc: null,
            clock: receivedOperations.length,
          });
        },
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ op: "1" })],
      });
      serverSync.saveRemote({ docId });
      await tick(5);

      await saveOperations(provider, docId, [ops({ op: "2" })]);
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
        return { docId, operations: [], serializedDoc: null, clock: 1 };
      });
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId);
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });
      serverSync.saveRemote({ docId });

      await tick(100);

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
                resolve({
                  docId,
                  operations: [],
                  serializedDoc: null,
                  clock: 1,
                }),
              30,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ first: "true" })],
      });

      serverSync.saveRemote({ docId });
      await tick(5);

      await saveOperations(provider, docId, [ops({ second: "true" })]);
      serverSync.saveRemote({ docId });
      await saveOperations(provider, docId, [ops({ third: "true" })]);
      serverSync.saveRemote({ docId });

      await tick(100);

      expect(mockApi.request).toHaveBeenCalledTimes(2);
      const secondCall = mockApi.request.mock.calls[1] as
        | [string, { operations: unknown[] }]
        | undefined;
      expect(secondCall?.[1].operations).toHaveLength(2);
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
            serializedDoc: null,
            clock: 1,
          };
        },
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      for (const docId of [docId1, docId2]) {
        await setupDocWithOperations(docBinding, provider, docId);
      }

      serverSync.saveRemote({ docId: docId1 });
      serverSync.saveRemote({ docId: docId2 });

      await tick(50);

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
                resolve({
                  docId,
                  operations: [],
                  serializedDoc: null,
                  clock: 1,
                }),
              20,
            ),
          ),
      );
      const { serverSync, docBinding, provider } =
        await createServerSync(mockApi);

      await setupDocWithOperations(docBinding, provider, docId);

      serverSync.saveRemote({ docId });
      await tick(5);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("pushing");

      serverSync.saveRemote({ docId });
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );

      await tick(100);
      expect(serverSync["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });
});
