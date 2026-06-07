import { describe, expect, test } from "vitest";
import { QueryClient } from "@tanstack/query-core";
import { DocSync2Client } from "@docukit/docsync2/client";
import { DocNodeBinding } from "@docukit/docsync2/docnode";
import { tick } from "../../utils.js";

declare const gc: (() => void) | undefined;

const testDocNodeArgs = { type: "note", id: "01j00000000000000000000000" };

const createDocNodeTestClient = () => {
  const queryClient = new QueryClient();
  const docBinding = DocNodeBinding([
    { type: testDocNodeArgs.type, extensions: [] },
  ]);
  const docSync = new DocSync2Client({ queryClient, docBinding });

  return { queryClient, docSync };
};

const createDocNodeTestDoc = ({
  docSync,
}: ReturnType<typeof createDocNodeTestClient>) =>
  docSync.mutations.createDoc(testDocNodeArgs);

const forceGc = async () => {
  if (typeof gc !== "function") {
    throw new Error(
      "Tests in this file require Node started with --expose-gc to validate GC behavior.",
    );
  }

  for (let i = 0; i < 5; i++) {
    gc();
    await tick(0);
  }
};

const createDocNodeWeakRefAfterTanStackClear = async () => {
  const testClient = createDocNodeTestClient();
  const created = await createDocNodeTestDoc(testClient);
  const weakRef = new WeakRef(created.doc);

  testClient.queryClient.clear();

  return { testClient, weakRef };
};

const createDocNodeWeakRefAfterTanStackRemove = async () => {
  const testClient = createDocNodeTestClient();
  const created = await createDocNodeTestDoc(testClient);
  const weakRef = new WeakRef(created.doc);

  testClient.queryClient.removeQueries({
    queryKey: testClient.docSync.queries.getDoc(testDocNodeArgs).queryKey,
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
