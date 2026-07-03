import { describe, expect, test } from "vitest";
import { isExistingGetDocData } from "@docukit/docsync2/client";
import { createTestClient, TestNode } from "../../utils/client.js";
import {
  disconnectTestClient,
  reconnectTestClient,
} from "../../utils/connection.js";
import {
  createTestDoc,
  observeDoc,
  waitForObservedDocResult,
  waitForDocStatus,
} from "../../utils/doc.js";
import { generateTestUserId } from "../../utils/generators.js";

describe("getDoc createIfMissing", () => {
  test("creates the doc and seeds getDoc", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync, docBinding } = testClient;

    const observed = observeDoc(testClient, {
      ...testClient.docArgs,
      createIfMissing: true,
    });
    try {
      const { data: queried } = await waitForDocStatus(
        testClient,
        observed,
        "idle",
      );
      const created = queryClient.getQueryData(
        docSync.queries.getDoc(testClient.docArgs).queryKey,
      );

      expect(isExistingGetDocData(created, docBinding)).toBe(true);
      if (!isExistingGetDocData(created, docBinding)) return;
      expect(queried.doc).toBe(created.doc);
      expect(queried).toStrictEqual(created);
    } finally {
      observed.unsubscribe();
    }
  });

  test("calling getDoc with createIfMissing twice for the same id keeps the existing getDoc doc", async () => {
    const testClient = createTestClient();

    const first = await createTestDoc(testClient);
    const second = await createTestDoc(testClient);

    expect(second.doc).toBe(first.doc);
    expect(second).toStrictEqual(first);
  });

  test("persists the created doc so getDoc can load it from the local provider", async () => {
    const testClient = createTestClient();
    const { queryClient, docBinding, docArgs } = testClient;

    const created = await createTestDoc(testClient);
    queryClient.clear();
    await disconnectTestClient(testClient);

    const observed = observeDoc(testClient, docArgs);
    const { data: queried } = await waitForDocStatus(
      testClient,
      observed,
      "paused",
    );

    expect(isExistingGetDocData(queried, docBinding)).toBe(true);
    if (!isExistingGetDocData(queried, docBinding)) return;
    expect(queried.doc).not.toBe(created.doc);
    expect(queried.doc.toJSON()).toStrictEqual(created.doc.toJSON());

    observed.unsubscribe();
  });

  test("disconnected client creates a local doc and seeds getDoc", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync, docBinding, docArgs } = testClient;
    await reconnectTestClient(testClient);
    await docSync["_localPromise"];
    await disconnectTestClient(testClient);

    const observed = observeDoc(testClient, {
      ...docArgs,
      createIfMissing: true,
    });
    await waitForDocStatus(testClient, observed, "paused");
    const created = queryClient.getQueryData(
      docSync.queries.getDoc(docArgs).queryKey,
    );
    expect(isExistingGetDocData(created, docBinding)).toBe(true);

    observed.unsubscribe();
  });

  test("observing an existing missing-doc query with createIfMissing creates the doc", async () => {
    const testClient = createTestClient();
    const { docArgs, docBinding } = testClient;

    const missingObserved = observeDoc(testClient, docArgs);
    await waitForObservedDocResult(
      missingObserved,
      (result) =>
        result.status === "success" &&
        result.fetchStatus === "idle" &&
        result.data?.doc === undefined,
    );
    missingObserved.unsubscribe();

    const createObserved = observeDoc(testClient, {
      ...docArgs,
      createIfMissing: true,
    });
    const { data } = await waitForDocStatus(testClient, createObserved, "idle");

    expect(isExistingGetDocData(data, docBinding)).toBe(true);

    createObserved.unsubscribe();
  });

  test("same-user clients sync local operations after both create the same missing doc", async () => {
    const userId = generateTestUserId();
    const source = createTestClient({
      timing: { singleClientMaxDebounce: 1000 },
      userId,
    });
    const target = createTestClient({ userId });
    const unsubscribes: (() => void)[] = [];

    try {
      const sourceObserved = observeDoc(source, {
        ...source.docArgs,
        createIfMissing: true,
      });
      unsubscribes.push(sourceObserved.unsubscribe);
      const targetObserved = observeDoc(target, {
        ...source.docArgs,
        createIfMissing: true,
      });
      unsubscribes.push(targetObserved.unsubscribe);

      const { data: sourceData } = await waitForDocStatus(
        source,
        sourceObserved,
        "idle",
      );
      const { data: targetData } = await waitForDocStatus(
        target,
        targetObserved,
        "idle",
      );

      sourceData.doc.root.append(sourceData.doc.createNode(TestNode));
      sourceData.doc.forceCommit();

      await expect
        .poll(() => targetData.doc.toJSON())
        .toStrictEqual(sourceData.doc.toJSON());
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      source.docSync.disconnect();
      target.docSync.disconnect();
      source.docSync.dispose();
      target.docSync.dispose();
    }
  });
});
