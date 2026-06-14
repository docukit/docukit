import { describe, expect, test } from "vitest";
import { tick } from "../../utils/async.js";
import { createTestClient } from "../../utils/client.js";
import { createTestDoc } from "../../utils/doc.js";

declare const gc: (() => void) | undefined;

const forceGc = async () => {
  if (typeof gc !== "function") {
    throw new Error(
      "Tests in this file require the browser started with --expose-gc to validate GC behavior.",
    );
  }

  for (let i = 0; i < 5; i++) {
    gc();
    await tick(0);
  }
};

const createDocNodeWeakRefAfterTanStackClear = async () => {
  const testClient = createTestClient();
  const created = await createTestDoc(testClient);
  const weakRef = new WeakRef(created.doc);

  testClient.queryClient.clear();

  return { testClient, weakRef };
};

const createDocNodeWeakRefAfterTanStackRemove = async () => {
  const testClient = createTestClient();
  const created = await createTestDoc(testClient);
  const weakRef = new WeakRef(created.doc);

  testClient.queryClient.removeQueries({
    queryKey: testClient.docSync.queries.getDoc(testClient.docArgs).queryKey,
  });

  return { testClient, weakRef };
};

describe("getDoc GC", () => {
  test("DocNode docs can be garbage-collected after TanStack clears the query cache", async () => {
    const { testClient, weakRef } =
      await createDocNodeWeakRefAfterTanStackClear();

    await forceGc();

    expect(testClient.queryClient.getQueryCache().getAll()).toStrictEqual([]);
    expect(weakRef.deref()).toBeUndefined();
  });

  test("DocNode docs can be garbage-collected after TanStack removes the doc query", async () => {
    const { testClient, weakRef } =
      await createDocNodeWeakRefAfterTanStackRemove();

    await forceGc();

    expect(testClient.queryClient.getQueryCache().getAll()).toStrictEqual([]);
    expect(weakRef.deref()).toBeUndefined();
  });
});
