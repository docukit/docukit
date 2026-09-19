import { expect, test } from "vitest";
import { indexedDBProvider } from "@docukit/docsync/client";
import type { JsonDoc, Operations } from "@docukit/docnode";

const provider = (userId: string) =>
  indexedDBProvider<JsonDoc, Operations>({ userId });

const doc = (id: string): JsonDoc => [id, "test", {}];

const open = (
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("blocked"));
  });

/** The database the schema before this one used, with something unsent in it. */
async function previousSchema(userId: string, pending: unknown[]) {
  const db = await open(`docsync-${userId}`, 1, (created) => {
    created.createObjectStore("docs", { keyPath: "docId" });
    created
      .createObjectStore("operations", { autoIncrement: true })
      .createIndex("docId_idx", "docId");
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["docs", "operations"], "readwrite");
    tx.objectStore("docs").put({
      docId: "a",
      serializedDoc: doc("a"),
      clock: 9,
    });
    for (const batch of pending) tx.objectStore("operations").add(batch);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
  });
  return db;
}

test("listClocks answers from stored documents and narrows by id", async () => {
  const local = provider(crypto.randomUUID());
  await local.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      docId: "a",
      serializedDoc: doc("a"),
      clock: 7,
    });
    await ctx.saveSerializedDoc({
      docId: "b",
      serializedDoc: doc("b"),
      clock: 3,
    });
  });

  // Index order, which is by clock.
  expect(
    await local.transaction("readonly", (ctx) => ctx.listClocks!()),
  ).toStrictEqual([
    { docId: "b", clock: 3 },
    { docId: "a", clock: 7 },
  ]);
  expect(
    await local.transaction("readonly", (ctx) =>
      ctx.listClocks!({ docIds: ["a", "never-stored"] }),
    ),
  ).toStrictEqual([{ docId: "a", clock: 7 }]);
});

test("moves unsent operations over from the previous schema", async () => {
  const userId = crypto.randomUUID();
  const old = await previousSchema(userId, [{ docId: "a", operations: [] }]);
  old.close();

  const local = provider(userId);
  // The snapshot is not moved: the server has it. The unsent operation is,
  // because nothing else does.
  await expect
    .poll(() =>
      local.transaction("readonly", (ctx) => ctx.getOperations({ docId: "a" })),
    )
    .toHaveLength(1);
  expect(
    await local.transaction("readonly", (ctx) =>
      ctx.getSerializedDoc({ docId: "a" }),
    ),
  ).toBeUndefined();

  // And with nobody left on that schema, its database is gone.
  await expect
    .poll(async () =>
      (await indexedDB.databases()).some(
        ({ name }) => name === `docsync-${userId}`,
      ),
    )
    .toBe(false);
});

test("what a tab on the old schema writes after the drain does not survive it", async () => {
  const userId = crypto.randomUUID();
  // A tab on the previous schema, with something unsent.
  const oldTab = await previousSchema(userId, [{ docId: "a", operations: [] }]);

  // A tab on this schema starts and takes that work over. Dropping the old
  // database is refused while that tab holds it, so the request waits.
  const local = provider(userId);
  await expect
    .poll(() =>
      local.transaction("readonly", (ctx) => ctx.getOperations({ docId: "a" })),
    )
    .toHaveLength(1);

  // The user writes again in the old tab and closes it before it can upload.
  await new Promise<void>((resolve, reject) => {
    const tx = oldTab.transaction("operations", "readwrite");
    tx.objectStore("operations").add({ docId: "b", operations: [] });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
  });
  oldTab.close();

  // Closing is what lets the drop run, and it takes that write with it. This
  // is the limit of keeping the old database around only until it is free:
  // reaching it needs the tab to be offline for the whole stretch between the
  // last start on this schema and its own close.
  await expect
    .poll(async () =>
      (await indexedDB.databases()).some(
        ({ name }) => name === `docsync-${userId}`,
      ),
    )
    .toBe(false);
  expect(
    await provider(userId).transaction("readonly", (ctx) =>
      ctx.getOperations({ docId: "b" }),
    ),
  ).toHaveLength(0);
});

test("two providers for the same user share one database", async () => {
  const userId = crypto.randomUUID();
  const first = provider(userId);
  const second = provider(userId);
  await first.transaction("readwrite", (ctx) =>
    ctx.saveSerializedDoc({ docId: "a", serializedDoc: doc("a"), clock: 1 }),
  );
  expect(
    await second.transaction("readonly", (ctx) =>
      ctx.getSerializedDoc({ docId: "a" }),
    ),
  ).toMatchObject({ clock: 1 });
});
