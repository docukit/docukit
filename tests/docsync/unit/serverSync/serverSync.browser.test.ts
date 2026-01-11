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
      const { client, provider } = await createServerSync();
      const doPushSpy = vi.spyOn(client, "_doPush" as keyof typeof client);
      const docId = generateDocId();

      await saveOperations(provider, docId);
      client.saveRemote({ docId });

      expect(doPushSpy).toHaveBeenCalledWith({ docId });
    });

    test("should set status to pushing-with-pending when called during a push", async () => {
      const { client, provider } = await createServerSync();
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((r) => setTimeout(r, 50)),
      );
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await saveOperations(provider, docId);
      client.saveRemote({ docId });
      await tick();
      client.saveRemote({ docId });

      expect(client["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );
    });

    test("should allow concurrent pushes for different docIds", async () => {
      const { client, provider } = await createServerSync();
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((r) => setTimeout(r, 20)),
      );
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId1 = generateDocId();
      const docId2 = generateDocId();

      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveOperations({ docId: docId1, operations: [emptyOps()] });
        await ctx.saveOperations({ docId: docId2, operations: [emptyOps()] });
      });

      client.saveRemote({ docId: docId1 });
      client.saveRemote({ docId: docId2 });
      await tick();

      expect(client["_pushStatusByDocId"].get(docId1)).toBe("pushing");
      expect(client["_pushStatusByDocId"].get(docId2)).toBe("pushing");
    });

    test("should be idempotent for same docId during push", async () => {
      const { client, provider } = await createServerSync();
      const mockApi = createMockApi();
      mockApi.request.mockImplementation(
        () => new Promise((r) => setTimeout(r, 50)),
      );
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const doPushSpy = vi.spyOn(client, "_doPush" as keyof typeof client);
      const docId = generateDocId();

      await saveOperations(provider, docId);
      client.saveRemote({ docId });
      client.saveRemote({ docId });
      client.saveRemote({ docId });
      await tick();

      expect(doPushSpy).toHaveBeenCalledTimes(1);
      expect(client["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );
    });

    test("should handle rapid successive calls correctly", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });

      await saveOperations(provider, docId);
      client.saveRemote({ docId });

      await tick();

      expect(mockApi.request).toHaveBeenCalledTimes(2);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Basic Flow
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Basic Flow", () => {
    test("should get operations from provider", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      const testOperations = [ops({ test: "data1" }), ops({ test: "data2" })];

      const { doc } = docBinding.new("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({
          docId,
          operations: testOperations,
        });
      });

      client.saveRemote({ docId });
      await tick();

      expect(mockApi.request).toHaveBeenCalledWith("sync-operations", {
        clock: 0,
        docId,
        operations: testOperations,
      });
    });

    test("should set status to pushing at start", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      const docId = generateDocId();
      let statusDuringPush: string | undefined;
      mockApi.request.mockImplementation(async () => {
        statusDuringPush = client["_pushStatusByDocId"].get(docId);
        return { docId, operations: [], serializedDoc: null, clock: 1 };
      });
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

      expect(statusDuringPush).toBe("pushing");
    });

    test("should send operations to API via sync-operations endpoint", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({ docId }),
      );
    });

    test("should include docId and clock in request", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

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
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      mockApi.request.mockResolvedValue({
        docId: "test-doc",
        operations: null,
        serializedDoc: null,
        clock: 1,
      });
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ test: "data" })],
      });

      client.saveRemote({ docId });
      await tick();

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [ops({ test: "data" })],
        }),
      );
      expect(await getOperationsCount(provider, docId)).toBe(0);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends operations + server returns operations", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ client: "op" })],
      });

      client.saveRemote({ docId });
      await tick();

      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [ops({ client: "op" })],
        }),
      );
      expect(await getOperationsCount(provider, docId)).toBe(0);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends no operations + server returns no operations (pull with no updates)", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      mockApi.request.mockResolvedValue({
        docId: "test-doc",
        operations: null,
        serializedDoc: null,
        clock: 1,
      });
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
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

      client.saveRemote({ docId });
      await tick();

      // Should call API even with no local operations (this is a pull)
      expect(mockApi.request).toHaveBeenCalledWith(
        "sync-operations",
        expect.objectContaining({
          docId,
          operations: [],
        }),
      );
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends no operations + server returns operations (pull with updates)", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      const docId = generateDocId();

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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

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
      client.saveRemote({ docId });
      await tick();

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
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Success Path
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Success Path", () => {
    test("should delete operations after successful push", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [emptyOps(), emptyOps()],
      });

      expect(await getOperationsCount(provider, docId)).toBe(2);

      client.saveRemote({ docId });
      await tick();

      expect(await getOperationsCount(provider, docId)).toBe(0);
    });

    test("should delete exact count of pushed operations", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ batch: "1" }), ops({ batch: "1" })],
      });

      client.saveRemote({ docId });
      await tick();

      await saveOperations(provider, docId, [ops({ batch: "2" })]);
      client.saveRemote({ docId });

      await tick(100);

      expect(await getOperationsCount(provider, docId)).toBe(0);
      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should consolidate operations into serialized doc after push", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
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

      client.saveRemote({ docId });
      await tick();

      expect(await getStoredClock(provider, docId)).toBe(1);
    });

    test("should increment clock after consolidation", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId, { clock: 5 });
      client.saveRemote({ docId });
      await tick();

      expect(await getStoredClock(provider, docId)).toBe(6);
    });

    test("should set status to idle after successful push", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      client["_api"] = mockApi as unknown as (typeof client)["_api"];
      const docId = generateDocId();

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // _doPush - Retry Logic
  // ──────────────────────────────────────────────────────────────────────────

  describe("_doPush - Retry Logic", () => {
    test("should retry if more operations were queued during push (pushing-with-pending)", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

      await saveOperations(provider, docId);
      client.saveRemote({ docId });

      await tick(100);

      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should retry on API failure", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

      expect(mockApi.request).toHaveBeenCalledTimes(2);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should set status to idle before retry", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      const docId = generateDocId();
      const statusHistory: (string | undefined)[] = [];
      mockApi.request.mockImplementation(() => {
        statusHistory.push(client["_pushStatusByDocId"].get(docId));
        if (statusHistory.length === 1)
          return Promise.reject(new Error("Network error"));
        return Promise.resolve({
          docId,
          operations: [],
          serializedDoc: null,
          clock: 1,
        });
      });
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      await tick();

      expect(statusHistory).toStrictEqual(["pushing", "pushing"]);
    });

    test("should handle retry with new operations", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ op: "1" })],
      });
      client.saveRemote({ docId });
      await tick();

      await saveOperations(provider, docId, [ops({ op: "2" })]);
      client.saveRemote({ docId });

      await tick();

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
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      const docId = generateDocId();
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      mockApi.request.mockImplementation(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await tick();
        concurrentCalls--;
        return { docId, operations: [], serializedDoc: null, clock: 1 };
      });
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);
      client.saveRemote({ docId });
      client.saveRemote({ docId });
      client.saveRemote({ docId });

      await tick();

      expect(maxConcurrent).toBe(1);
    });

    test("should queue operations that arrive during push", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId, {
        operations: [ops({ first: "true" })],
      });

      client.saveRemote({ docId });
      await tick();

      await saveOperations(provider, docId, [ops({ second: "true" })]);
      client.saveRemote({ docId });
      await saveOperations(provider, docId, [ops({ third: "true" })]);
      client.saveRemote({ docId });

      await tick(100);

      expect(mockApi.request).toHaveBeenCalledTimes(2);
      const secondCall = mockApi.request.mock.calls[1] as
        | [string, { operations: unknown[] }]
        | undefined;
      expect(secondCall?.[1].operations).toHaveLength(2);
    });

    test("should handle interleaved operations from different docs", async () => {
      const { client, docBinding, provider } = await createServerSync();
      const mockApi = createMockApi();
      const docId1 = generateDocId();
      const docId2 = generateDocId();
      const callOrder: string[] = [];
      mockApi.request.mockImplementation(
        async (_: unknown, payload: { docId: string }) => {
          callOrder.push(payload.docId);
          await tick();
          return {
            docId: payload.docId,
            operations: [],
            serializedDoc: null,
            clock: 1,
          };
        },
      );
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      for (const docId of [docId1, docId2]) {
        await setupDocWithOperations(docBinding, provider, docId);
      }

      client.saveRemote({ docId: docId1 });
      client.saveRemote({ docId: docId2 });

      await tick();

      expect(callOrder).toContain(docId1);
      expect(callOrder).toContain(docId2);
      expect(mockApi.request).toHaveBeenCalledTimes(2);
    });

    test("should handle status changes during async operations", async () => {
      const { client, docBinding, provider } = await createServerSync();
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
      client["_api"] = mockApi as unknown as (typeof client)["_api"];

      await setupDocWithOperations(docBinding, provider, docId);

      client.saveRemote({ docId });
      await tick();
      expect(client["_pushStatusByDocId"].get(docId)).toBe("pushing");

      client.saveRemote({ docId });
      expect(client["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );

      await tick(100);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });
  });
});
