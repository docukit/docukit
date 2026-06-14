import { describe, expect, test } from "vitest";
import { tick } from "../../utils/async.js";
import { createTestClient, TestNode } from "../../utils/client.js";
import {
  disconnectTestClient,
  reconnectTestClient,
} from "../../utils/connection.js";
import {
  createTestDoc,
  getTestDocOperationBatchCount,
  getTestDocKey,
  observeDoc,
  observeTestDoc,
  waitForNextDocResult,
  waitForDocStatus,
  waitForObservedTestDocResult,
} from "../../utils/doc.js";

describe("getDoc", () => {
  test("two observers for the same doc id receive the same in-memory doc", async () => {
    const testClient = createTestClient();
    const created = await createTestDoc(testClient);

    const observed1 = observeTestDoc(testClient);
    const observed2 = observeTestDoc(testClient);

    const result1 = observed1.observer.getCurrentResult();
    const result2 = observed2.observer.getCurrentResult();

    expect(result1.data?.doc).toBe(created.doc);
    expect(result2.data?.doc).toBe(created.doc);
    expect(result1.data?.doc).toBe(result2.data?.doc);

    observed1.unsubscribe();
    observed2.unsubscribe();
  });

  test("unsubscribing one observer keeps the doc alive while another observer is active", async () => {
    const testClient = createTestClient();
    const { queryClient } = testClient;
    const created = await createTestDoc(testClient);
    const key = getTestDocKey(testClient);

    const observed1 = observeTestDoc(testClient);
    const observed2 = observeTestDoc(testClient);

    observed1.unsubscribe();
    await tick();

    expect(queryClient.getQueryData(key)).toStrictEqual(created);

    observed2.unsubscribe();
  });

  test("unsubscribing the last observer keeps the doc cached until TanStack removes the query", async () => {
    const testClient = createTestClient();
    const { queryClient } = testClient;
    const created = await createTestDoc(testClient);
    const key = getTestDocKey(testClient);
    const observed = observeTestDoc(testClient);

    observed.unsubscribe();
    await tick();

    expect(queryClient.getQueryData(key)).toStrictEqual(created);
  });

  test("when TanStack removes the doc query, the doc leaves the query cache", async () => {
    const testClient = createTestClient();
    const { queryClient } = testClient;
    await createTestDoc(testClient);
    const key = getTestDocKey(testClient);
    const observed = observeTestDoc(testClient);

    observed.unsubscribe();
    queryClient.removeQueries({ queryKey: key });

    expect(queryClient.getQueryData(key)).toBeUndefined();
  });

  test("local IndexedDB data is cached while the remote query is paused", async () => {
    const testClient = createTestClient();
    const created = await createTestDoc(testClient);

    testClient.queryClient.clear();
    await reconnectTestClient(testClient);
    await disconnectTestClient(testClient);

    const observed = observeTestDoc(testClient);

    const { result, data } = await waitForDocStatus(
      testClient,
      observed,
      "paused",
    );
    expect(result.dataUpdatedAt).toBe(0);
    expect(data.doc.toJSON()).toStrictEqual(created.doc.toJSON());

    testClient.docSync.connect();
    const idleResult = await waitForObservedTestDocResult(
      observed,
      (result) => result.fetchStatus === "idle" && result.dataUpdatedAt > 0,
    );
    expect(idleResult.dataUpdatedAt).toBeGreaterThan(0);

    observed.unsubscribe();
    testClient.docSync.disconnect();
  });

  test("connected client caches local IndexedDB data while the remote query is fetching", async () => {
    const testClient = createTestClient();
    const created = await createTestDoc(testClient);
    await reconnectTestClient(testClient);

    testClient.queryClient.clear();
    const observed = observeTestDoc(testClient);

    const { result, data } = await waitForDocStatus(
      testClient,
      observed,
      "fetching",
    );
    expect(result.dataUpdatedAt).toBe(0);
    expect(data.doc.toJSON()).toStrictEqual(created.doc.toJSON());

    const idleResult = await waitForObservedTestDocResult(
      observed,
      (result) => result.fetchStatus === "idle" && result.dataUpdatedAt > 0,
    );
    expect(idleResult.fetchStatus).toBe("idle");
    expect(idleResult.dataUpdatedAt).toBeGreaterThan(0);

    observed.unsubscribe();
    testClient.docSync.disconnect();
  });

  test("doc changes are persisted as local operations while observed", async () => {
    const testClient = createTestClient({
      timing: { singleClientMaxDebounce: 0 },
    });
    const created = await createTestDoc(testClient);
    await reconnectTestClient(testClient);
    await disconnectTestClient(testClient);
    const observed = observeTestDoc(testClient);

    await tick();
    created.doc.root.append(created.doc.createNode(TestNode));
    created.doc.forceCommit();

    await expect
      .poll(() => getTestDocOperationBatchCount(testClient, created.docId))
      .toBe(1);

    observed.unsubscribe();
  });

  test("local doc changes refetch the active getDoc query", async () => {
    const testClient = createTestClient({
      timing: { singleClientMaxDebounce: 0 },
    });
    await createTestDoc(testClient);
    await reconnectTestClient(testClient);
    testClient.queryClient.clear();
    const observed = observeTestDoc(testClient);

    const { result: initialIdle, data } = await waitForDocStatus(
      testClient,
      observed,
      "idle",
    );
    expect(initialIdle.dataUpdatedAt).toBeGreaterThan(0);
    const fetching = waitForNextDocResult(
      observed,
      (result) => result.fetchStatus === "fetching",
    );

    data.doc.root.append(data.doc.createNode(TestNode));
    data.doc.forceCommit();

    await fetching;
    const nextIdle = await waitForNextDocResult(
      observed,
      (result) =>
        result.fetchStatus === "idle" &&
        result.dataUpdatedAt > initialIdle.dataUpdatedAt,
    );

    expect(nextIdle.dataUpdatedAt).toBeGreaterThan(initialIdle.dataUpdatedAt);

    observed.unsubscribe();
    testClient.docSync.disconnect();
  });

  test("server sync errors fail the getDoc query", async () => {
    const testClient = createTestClient();
    const docArgs = {
      type: testClient.docArgs.type,
      id: "01j00000000000000000000000",
    };
    await reconnectTestClient(testClient);
    const syncEvents: Array<{ attempt: number; type: string }> = [];
    const off = testClient.docSync.on("sync", (event) => {
      if (event.req.docId !== docArgs.id) return;
      if (event.error) {
        syncEvents.push({ attempt: event.attempt, type: event.error.type });
      }
    });

    try {
      await expect(
        testClient.queryClient.fetchQuery(
          testClient.docSync.queries.getDoc(docArgs),
        ),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
      expect(syncEvents).toStrictEqual([
        { attempt: 1, type: "AuthorizationError" },
      ]);
    } finally {
      off();
      testClient.docSync.disconnect();
    }
  });

  test("connecting pushes pending local operations and clears the local queue", async () => {
    const testClient = createTestClient({
      timing: { singleClientMaxDebounce: 0 },
    });
    const created = await createTestDoc(testClient);
    await reconnectTestClient(testClient);
    await disconnectTestClient(testClient);
    const observed = observeTestDoc(testClient);

    await tick();
    created.doc.root.append(created.doc.createNode(TestNode));
    created.doc.forceCommit();

    await expect
      .poll(() => getTestDocOperationBatchCount(testClient, created.docId))
      .toBe(1);

    testClient.docSync.connect();

    await expect
      .poll(() => getTestDocOperationBatchCount(testClient, created.docId))
      .toBe(0);

    testClient.docSync.disconnect();
    observed.unsubscribe();
  });

  test("local doc changes use single-client debounce before persisting", async () => {
    const testClient = createTestClient({
      timing: { singleClientMaxDebounce: 30 },
    });
    const created = await createTestDoc(testClient);
    await reconnectTestClient(testClient);
    await disconnectTestClient(testClient);
    const observed = observeTestDoc(testClient);

    await tick();
    created.doc.root.append(created.doc.createNode(TestNode));
    created.doc.forceCommit();

    await tick(10);
    expect(await getTestDocOperationBatchCount(testClient, created.docId)).toBe(
      0,
    );

    await expect
      .poll(() => getTestDocOperationBatchCount(testClient, created.docId))
      .toBe(1);

    observed.unsubscribe();
  });

  test("local doc changes use collaborative debounce for collaborator docs", async () => {
    const testClient = createTestClient({
      timing: { collabMaxDebounce: 10, singleClientMaxDebounce: 1000 },
    });
    const created = await createTestDoc(testClient);
    await reconnectTestClient(testClient);
    await disconnectTestClient(testClient);
    const observed = observeTestDoc(testClient);
    testClient.docSync["_collabDocIds"].add(created.docId);

    await tick();
    created.doc.root.append(created.doc.createNode(TestNode));
    created.doc.forceCommit();

    await tick();
    expect(await getTestDocOperationBatchCount(testClient, created.docId)).toBe(
      0,
    );

    await expect
      .poll(() => getTestDocOperationBatchCount(testClient, created.docId))
      .toBe(1);

    observed.unsubscribe();
  });

  test("collaboration flushes pending local operations", async () => {
    const reference = createTestClient({
      timing: { collabMaxDebounce: 10, singleClientMaxDebounce: 1000 },
    });
    const peer = createTestClient();
    const unsubscribes: (() => void)[] = [];

    try {
      const created = await createTestDoc(reference);
      await reconnectTestClient(reference);
      const referenceObserved = observeTestDoc(reference);
      await waitForDocStatus(reference, referenceObserved, "idle");
      unsubscribes.push(referenceObserved.unsubscribe);

      created.doc.root.append(created.doc.createNode(TestNode));
      created.doc.forceCommit();
      await tick(20);
      expect(
        await getTestDocOperationBatchCount(reference, created.docId),
      ).toBe(0);

      const syncedPendingOperations = new Promise<void>((resolve, reject) => {
        const off = reference.docSync.on("sync", (event) => {
          if (event.req.docId !== created.docId) return;
          if ((event.req.operations?.length ?? 0) === 0) return;

          off();
          if (event.error) {
            reject(new Error(event.error.message));
            return;
          }
          resolve();
        });
      });

      const peerObserved = observeDoc(peer, reference.docArgs);
      unsubscribes.push(peerObserved.unsubscribe);
      await waitForDocStatus(peer, peerObserved, "idle");
      await syncedPendingOperations;
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      reference.docSync.disconnect();
      reference.docSync.dispose();
      peer.docSync.disconnect();
      peer.docSync.dispose();
    }
  });

  test("disposing the client removes doc queries", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync } = testClient;
    await createTestDoc(testClient);
    const key = getTestDocKey(testClient);

    docSync.dispose();

    expect(queryClient.getQueryData(key)).toBeUndefined();
  });

  test.todo("disconnected client can still read a locally created doc");
  test.todo(
    "connected and disconnected client expose the same local doc result",
  );
});
