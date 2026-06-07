import { describe, expect, test } from "vitest";
import {
  createTestClient,
  createTestDoc,
  getTestDocKey,
  observeTestDoc,
  tick,
} from "../../utils/index.js";

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
