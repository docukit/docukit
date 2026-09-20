import { expect, test } from "vitest";
import { indexedDBProvider } from "@docukit/docsync/client";
import { openPreviousDatabase, transactionDone } from "./indexeddb/utils.js";

test("lists stored clocks, including ties and zero, and filters document IDs", async () => {
  const local = indexedDBProvider({ userId: crypto.randomUUID() });
  expect(
    await local.transaction("readonly", (ctx) => ctx.listClocks!()),
  ).toStrictEqual([]);

  await local.transaction("readwrite", async (ctx) => {
    for (const [docId, clock] of [
      ["a", 7],
      ["b", 3],
      ["c", 3],
      ["d", 0],
    ] as const)
      await ctx.saveSerializedDoc({
        docId,
        clock,
        serializedDoc: { text: docId },
      });
  });
  expect(
    await local.transaction("readonly", (ctx) => ctx.listClocks!()),
  ).toStrictEqual([
    { docId: "d", clock: 0 },
    { docId: "b", clock: 3 },
    { docId: "c", clock: 3 },
    { docId: "a", clock: 7 },
  ]);
  expect(
    await local.transaction("readonly", (ctx) =>
      ctx.listClocks!({ docIds: ["a", "a", "missing"] }),
    ),
  ).toStrictEqual([{ docId: "a", clock: 7 }]);
  expect(
    await local.transaction("readonly", (ctx) =>
      ctx.listClocks!({ docIds: [] }),
    ),
  ).toStrictEqual([]);

  await local.transaction("readwrite", (ctx) =>
    ctx.saveSerializedDoc({
      docId: "a",
      clock: 9,
      serializedDoc: { text: "updated" },
    }),
  );
  expect(
    await local.transaction("readonly", (ctx) =>
      ctx.listClocks!({ docIds: ["a"] }),
    ),
  ).toStrictEqual([{ docId: "a", clock: 9 }]);
});

test("providers on the same schema share snapshots and acknowledge exact operation batches", async () => {
  const userId = crypto.randomUUID();
  const first = indexedDBProvider({ userId });
  await first.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      docId: "a",
      clock: 1,
      serializedDoc: { text: "saved" },
    });
    await ctx.saveOperations({ docId: "a", operations: [{ insert: "first" }] });
    await ctx.saveOperations({
      docId: "a",
      operations: [{ insert: "second" }],
    });
  });
  const second = indexedDBProvider({ userId });
  expect(
    await second.transaction("readonly", (ctx) =>
      ctx.getSerializedDoc({ docId: "a" }),
    ),
  ).toStrictEqual({ docId: "a", clock: 1, serializedDoc: { text: "saved" } });
  const batches = await second.transaction("readonly", (ctx) =>
    ctx.getOperations({ docId: "a" }),
  );
  expect(batches.map(({ operations }) => operations)).toStrictEqual([
    [{ insert: "first" }],
    [{ insert: "second" }],
  ]);
  await second.transaction("readwrite", (ctx) =>
    ctx.deleteOperations({ docId: "a", ids: [batches[0]!.id] }),
  );
  expect(
    await first.transaction("readonly", (ctx) =>
      ctx.getOperations({ docId: "a" }),
    ),
  ).toStrictEqual([batches[1]]);
});

test("keeps users with schema-like suffixes isolated", async () => {
  const userId = crypto.randomUUID();
  const first = indexedDBProvider({ userId });
  await first.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      docId: "a",
      clock: 1,
      serializedDoc: { text: "private" },
    });
    await ctx.saveOperations({
      docId: "a",
      operations: [{ insert: "private" }],
    });
  });
  const second = indexedDBProvider({ userId: `${userId}-2` });
  await second.transaction("readonly", async (ctx) => {
    expect(await ctx.listClocks!()).toStrictEqual([]);
    expect(await ctx.getSerializedDoc({ docId: "a" })).toBeUndefined();
    expect(await ctx.getOperations({ docId: "a" })).toStrictEqual([]);
  });
});

test("starts empty while a previous database with unsent work remains open", async () => {
  const userId = crypto.randomUUID();
  const previous = await openPreviousDatabase(userId);
  const write = previous.transaction(["docs", "operations"], "readwrite");
  write
    .objectStore("docs")
    .put({ docId: "a", clock: 0, serializedDoc: { text: "local only" } });
  write
    .objectStore("operations")
    .add({ docId: "a", operations: [{ insert: "unsent" }] });
  await transactionDone(write);

  const local = indexedDBProvider({ userId });
  await local.transaction("readonly", async (ctx) => {
    expect(await ctx.listClocks!()).toStrictEqual([]);
    expect(await ctx.getSerializedDoc({ docId: "a" })).toBeUndefined();
    expect(await ctx.getOperations({ docId: "a" })).toStrictEqual([]);
  });
  await local.transaction("readwrite", (ctx) =>
    ctx.saveSerializedDoc({
      docId: "a",
      clock: 5,
      serializedDoc: { text: "current" },
    }),
  );

  const read = previous.transaction(["docs", "operations"]);
  const snapshot = read.objectStore("docs").get("a");
  const pending = read.objectStore("operations").count();
  await transactionDone(read);
  expect(snapshot.result).toStrictEqual({
    docId: "a",
    clock: 0,
    serializedDoc: { text: "local only" },
  });
  expect(pending.result).toBe(1);
});
