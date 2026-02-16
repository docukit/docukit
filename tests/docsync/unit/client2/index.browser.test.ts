import { describe, test, expect } from "vitest";
import {
  createClient,
  generateDocId,
  setupDocWithOperations,
  saveOperations,
  getOperationsCount,
  getStoredClock,
  tick,
  ops,
  emptyOps,
  ChildNode,
  spyOnRequest,
  triggerSync,
} from "./utils.js";
import type { Operations } from "@docukit/docnode";

describe("Client 2", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // sync (triggered by dirty)
  // ──────────────────────────────────────────────────────────────────────────

  describe("sync (triggered by dirty)", () => {
    test("should trigger sync when status is idle", async () => {
      const client = await createClient();
      const requestSpy = spyOnRequest(client);
      const docId = generateDocId();

      await saveOperations(client, docId);
      triggerSync(client, docId);

      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ docId }),
      );
    });

    test("should set status to pushing-with-pending when called during a push", async () => {
      const client = await createClient();
      const docId = generateDocId();
      spyOnRequest(client).mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(() => r({ data: { docId, clock: 1 } }), 50),
          ),
      );

      await saveOperations(client, docId);
      triggerSync(client, docId);
      triggerSync(client, docId);

      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId))
        .toBe("pushing-with-pending");
    });

    test("should allow concurrent pushes for different docIds", async () => {
      const client = await createClient();
      const docId1 = generateDocId();
      const docId2 = generateDocId();
      spyOnRequest(client).mockImplementation(
        (_event, payload) =>
          new Promise((r) =>
            setTimeout(
              () => r({ data: { docId: payload.docId, clock: 1 } }),
              20,
            ),
          ),
      );

      const provider = (await client["_localPromise"]).provider;
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveOperations({ docId: docId1, operations: [emptyOps()] });
        await ctx.saveOperations({ docId: docId2, operations: [emptyOps()] });
      });

      triggerSync(client, docId1);
      triggerSync(client, docId2);
      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId1))
        .toBe("pushing");
      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId2))
        .toBe("pushing");
    });

    test("should be idempotent for same docId during push", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(() => r({ data: { docId, clock: 1 } }), 50),
          ),
      );

      await saveOperations(client, docId);
      triggerSync(client, docId);
      triggerSync(client, docId);
      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBe(1);
      expect(client["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );
    });

    test("should handle rapid successive calls correctly", async () => {
      const client = await createClient();
      let callCount = 0;
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ data: { docId, clock: callCount } });
      });

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);

      await saveOperations(client, docId);
      triggerSync(client, docId);

      await expect.poll(() => requestSpy.mock.calls.length).toBe(2);
      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId))
        .toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // handleSync - Basic Flow
  // ──────────────────────────────────────────────────────────────────────────

  describe("handleSync - Basic Flow", () => {
    test("should get operations from provider", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);

      const testOperations = [ops({ test: "data1" }), ops({ test: "data2" })];

      const docBinding = client["_docBinding"];
      const provider = (await client["_localPromise"]).provider;
      const { doc } = docBinding.create("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: testOperations });
      });

      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith("sync", {
        clock: 0,
        docId,
        operations: testOperations,
      });
    });

    test("should set status to pushing at start", async () => {
      const client = await createClient();
      const docId = generateDocId();
      let statusDuringPush: string | undefined;
      spyOnRequest(client).mockImplementation(async () => {
        statusDuringPush = client["_pushStatusByDocId"].get(docId);
        return { data: { docId, clock: 1 } };
      });

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await expect.poll(() => statusDuringPush).toBe("pushing");
    });

    test("should send operations to API via sync endpoint", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ docId }),
      );
    });

    test("should include docId and clock in request", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ clock: 0, docId }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // handleSync - Client/Server Operation Combinations (2x2 matrix)
  // ──────────────────────────────────────────────────────────────────────────

  describe("handleSync - Client/Server Operation Combinations", () => {
    test("should handle client sends operations + server returns no operations", async () => {
      const client = await createClient();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockResolvedValue({ data: { docId: "test-doc", clock: 1 } });
      const docId = generateDocId();

      await setupDocWithOperations(client, docId, {
        operations: [ops({ test: "data" })],
      });

      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ docId, operations: [ops({ test: "data" })] }),
      );
      expect(await getOperationsCount(client, docId)).toBe(0);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends operations + server returns operations", async () => {
      const client = await createClient();
      const docId = generateDocId();

      // Mock server operations using ops helper to avoid ID conflicts
      const serverOperations = [ops({ server: "op1" }), ops({ server: "op2" })];

      // Mock API to return server operations
      const requestSpy = spyOnRequest(client);
      requestSpy.mockResolvedValue({
        data: { docId, operations: serverOperations, clock: 1 },
      });

      await setupDocWithOperations(client, docId, {
        operations: [ops({ client: "op" })],
      });

      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ docId, operations: [ops({ client: "op" })] }),
      );
      expect(await getOperationsCount(client, docId)).toBe(0);
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends no operations + server returns no operations (pull with no updates)", async () => {
      const client = await createClient();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockResolvedValue({ data: { docId: "test-doc", clock: 1 } });
      const docId = generateDocId();

      // Setup a document without pending operations (pure pull scenario)
      const docBinding = client["_docBinding"];
      const provider = (await client["_localPromise"]).provider;
      const { doc: initialDoc } = docBinding.create("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
      });

      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ docId, operations: [] }),
      );
      expect(client["_pushStatusByDocId"].get(docId)).toBe("idle");
    });

    test("should handle client sends no operations + server returns operations (pull with updates)", async () => {
      const client = await createClient();
      const docId = generateDocId();

      // Create server operations by modifying a doc
      const docBinding = client["_docBinding"];
      const { doc: serverDoc } = docBinding.create("test", docId);
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
      const requestSpy = spyOnRequest(client);
      requestSpy.mockResolvedValue({
        data: { docId, operations: serverOperations, clock: 1 },
      });

      // Setup a document without pending operations (pure pull scenario)
      const provider = (await client["_localPromise"]).provider;
      const { doc: initialDoc } = docBinding.create("test", docId);
      await provider.transaction("readwrite", async (ctx) => {
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
      });

      // Trigger pull - client has no operations but wants server's updates
      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBeGreaterThan(0);
      expect(requestSpy).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({ docId, operations: [] }),
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
  // handleSync - Success Path
  // ──────────────────────────────────────────────────────────────────────────

  describe("handleSync - Success Path", () => {
    test("should delete operations after successful push", async () => {
      const client = await createClient();
      const docId = generateDocId();
      spyOnRequest(client).mockResolvedValue({ data: { docId, clock: 1 } });

      await setupDocWithOperations(client, docId, {
        operations: [emptyOps(), emptyOps()],
      });

      expect(await getOperationsCount(client, docId)).toBe(2);

      triggerSync(client, docId);
      await expect
        .poll(async () => await getOperationsCount(client, docId))
        .toBe(0);
    });

    test("should delete exact count of pushed operations", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { docId, clock: 1 } }), 30),
          ),
      );

      await setupDocWithOperations(client, docId, {
        operations: [ops({ batch: "1" }), ops({ batch: "1" })],
      });

      triggerSync(client, docId);
      await saveOperations(client, docId, [ops({ batch: "2" })]);
      triggerSync(client, docId);

      await expect
        .poll(async () => await getOperationsCount(client, docId))
        .toBe(0);
      expect(requestSpy).toHaveBeenCalledTimes(2);
    });

    test("should consolidate operations into serialized doc after push", async () => {
      const client = await createClient();
      const docId = generateDocId();
      spyOnRequest(client).mockResolvedValue({ data: { docId, clock: 1 } });

      const docBinding = client["_docBinding"];
      const provider = (await client["_localPromise"]).provider;
      const { doc } = docBinding.create("test", docId);
      const child = doc.createNode(ChildNode);
      doc.root.append(child);

      await provider.transaction("readwrite", async (ctx) => {
        const initialDoc = docBinding.create("test", docId).doc;
        await ctx.saveSerializedDoc({
          serializedDoc: docBinding.serialize(initialDoc),
          docId,
          clock: 0,
        });
        await ctx.saveOperations({ docId, operations: [emptyOps()] });
      });

      triggerSync(client, docId);
      await expect
        .poll(async () => await getStoredClock(client, docId))
        .toBe(1);
    });

    test("should increment clock after consolidation", async () => {
      const client = await createClient();
      const docId = generateDocId();
      spyOnRequest(client).mockResolvedValue({ data: { docId, clock: 6 } });

      await setupDocWithOperations(client, docId, { clock: 5 });
      triggerSync(client, docId);
      await expect
        .poll(async () => await getStoredClock(client, docId))
        .toBe(6);
    });

    test("should set status to idle after successful push", async () => {
      const client = await createClient();
      const docId = generateDocId();
      spyOnRequest(client).mockResolvedValue({ data: { docId, clock: 1 } });

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId))
        .toBe("idle");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // handleSync - Retry Logic
  // ──────────────────────────────────────────────────────────────────────────

  describe("handleSync - Retry Logic", () => {
    test("should retry if more operations were queued during push (pushing-with-pending)", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { docId, clock: 1 } }), 20),
          ),
      );

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await saveOperations(client, docId);
      triggerSync(client, docId);

      await expect.poll(() => requestSpy.mock.calls.length).toBe(2);
    });

    test("should retry on API failure", async () => {
      const client = await createClient();
      const docId = generateDocId();
      let callCount = 0;
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("Network error"));
        return Promise.resolve({ data: { docId, operations: [], clock: 1 } });
      });

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await expect.poll(() => requestSpy.mock.calls.length).toBe(2);
      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId))
        .toBe("idle");
    });

    test("should set status to idle before retry", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const statusHistory: (string | undefined)[] = [];
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(() => {
        statusHistory.push(client["_pushStatusByDocId"].get(docId));
        if (statusHistory.length === 1)
          return Promise.reject(new Error("Network error"));
        return Promise.resolve({ data: { docId, operations: [], clock: 1 } });
      });

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      await expect
        .poll(() => statusHistory)
        .toStrictEqual(["pushing", "pushing"]);
    });

    test("should handle retry with new operations", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const receivedOperations: unknown[] = [];
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation((_event, payload) => {
        if ("operations" in payload) {
          receivedOperations.push(payload.operations);
        }
        return Promise.resolve({
          data: { docId, clock: receivedOperations.length },
        });
      });

      await setupDocWithOperations(client, docId, {
        operations: [ops({ op: "1" })],
      });
      triggerSync(client, docId);
      await saveOperations(client, docId, [ops({ op: "2" })]);
      triggerSync(client, docId);

      await expect.poll(() => receivedOperations.length).toBe(2);
      expect(receivedOperations[0]).toStrictEqual([ops({ op: "1" })]);
      expect(receivedOperations[1]).toStrictEqual([ops({ op: "2" })]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // handleSync - Concurrency
  // ──────────────────────────────────────────────────────────────────────────

  describe("handleSync - Concurrency", () => {
    test("should not push same doc twice simultaneously", async () => {
      const client = await createClient();
      const docId = generateDocId();
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      spyOnRequest(client).mockImplementation(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await tick();
        concurrentCalls--;
        return { data: { docId, clock: 1 } };
      });

      await setupDocWithOperations(client, docId);
      triggerSync(client, docId);
      triggerSync(client, docId);
      triggerSync(client, docId);

      await expect.poll(() => maxConcurrent).toBe(1);
    });

    test("should queue operations that arrive during push", async () => {
      const client = await createClient();
      const docId = generateDocId();
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { docId, clock: 1 } }), 30),
          ),
      );

      await setupDocWithOperations(client, docId, {
        operations: [ops({ first: "true" })],
      });

      triggerSync(client, docId);
      await saveOperations(client, docId, [ops({ second: "true" })]);
      triggerSync(client, docId);
      await saveOperations(client, docId, [ops({ third: "true" })]);
      triggerSync(client, docId);

      await expect.poll(() => requestSpy.mock.calls.length).toBe(2);
      const secondCall = requestSpy.mock.calls[1] as
        | [string, { operations: unknown[] }]
        | undefined;
      expect(secondCall?.[1].operations).toHaveLength(2);
    });

    test("should handle interleaved operations from different docs", async () => {
      const client = await createClient();
      const docId1 = generateDocId();
      const docId2 = generateDocId();
      const callOrder: string[] = [];
      const requestSpy = spyOnRequest(client);
      requestSpy.mockImplementation(async (_event, payload) => {
        callOrder.push(payload.docId);
        await tick();
        return { data: { docId: payload.docId, clock: 1 } };
      });

      for (const docId of [docId1, docId2]) {
        await setupDocWithOperations(client, docId);
      }

      triggerSync(client, docId1);
      triggerSync(client, docId2);

      await expect.poll(() => callOrder.length).toBe(2);
      expect(callOrder).toContain(docId1);
      expect(callOrder).toContain(docId2);
      expect(requestSpy).toHaveBeenCalledTimes(2);
    });

    test("should handle status changes during async operations", async () => {
      const client = await createClient();
      const docId = generateDocId();
      spyOnRequest(client).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { docId, clock: 1 } }), 20),
          ),
      );

      await setupDocWithOperations(client, docId);

      triggerSync(client, docId);
      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId))
        .toBe("pushing");

      triggerSync(client, docId);
      expect(client["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );

      await expect
        .poll(() => client["_pushStatusByDocId"].get(docId))
        .toBe("idle");
    });
  });
});
