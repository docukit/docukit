import { expect, test, vi } from "vitest";
import {
  indexedDBProvider,
  OutdatedDatabaseError,
} from "@docukit/docsync/client";
import type { JsonDoc, Operations } from "@docukit/docnode";

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

test("lets go when a newer build needs to change the version, and says so", async () => {
  const userId = crypto.randomUUID();
  const onOutdated = vi.fn();
  const local = indexedDBProvider<JsonDoc, Operations>(
    { userId },
    { onOutdated },
  );
  await local.transaction("readwrite", (ctx) =>
    ctx.saveSerializedDoc({ docId: "a", serializedDoc: doc("a"), clock: 1 }),
  );

  // A tab on a newer build. Its open waits on every connection that is open,
  // and every later open on this database waits behind it, so resolving is the
  // whole point.
  const newer = await open(`docsync-${userId}`, 3);
  newer.close();

  expect(onOutdated).toHaveBeenCalledTimes(1);
  // Whatever that build put there belongs to a schema this one does not know.
  await expect(
    local.transaction("readonly", (ctx) =>
      ctx.getSerializedDoc({ docId: "a" }),
    ),
  ).rejects.toThrow(OutdatedDatabaseError);
});

test("says the same thing when the database was already a newer build's", async () => {
  const userId = crypto.randomUUID();
  const ahead = await open(`docsync-${userId}`, 7, (db) => {
    db.createObjectStore("docs", { keyPath: "docId" });
  });
  ahead.close();

  const onOutdated = vi.fn();
  const local = indexedDBProvider<JsonDoc, Operations>(
    { userId },
    { onOutdated },
  );
  await expect(
    local.transaction("readonly", (ctx) =>
      ctx.getSerializedDoc({ docId: "a" }),
    ),
  ).rejects.toThrow(OutdatedDatabaseError);
  expect(onOutdated).toHaveBeenCalledTimes(1);
});

test("reads and writes normally when nothing else wants the database", async () => {
  const userId = crypto.randomUUID();
  const local = indexedDBProvider<JsonDoc, Operations>({ userId });
  await local.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      docId: "a",
      serializedDoc: doc("a"),
      clock: 3,
    });
    await ctx.saveOperations({ docId: "a", operations: [] });
  });
  const [stored, pending] = await local.transaction("readonly", async (ctx) => [
    await ctx.getSerializedDoc({ docId: "a" }),
    await ctx.getOperations({ docId: "a" }),
  ]);
  expect(stored).toMatchObject({ clock: 3 });
  expect(pending).toHaveLength(1);
});

test("listClocks answers from stored documents and narrows by id", async () => {
  const local = indexedDBProvider<JsonDoc, Operations>({
    userId: crypto.randomUUID(),
  });
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

test("a database from the previous release gains the index and keeps its work", async () => {
  const userId = crypto.randomUUID();
  const old = await open(`docsync-${userId}`, 1, (db) => {
    db.createObjectStore("docs", { keyPath: "docId" });
    db.createObjectStore("operations", { autoIncrement: true }).createIndex(
      "docId_idx",
      "docId",
    );
  });
  await new Promise<void>((resolve, reject) => {
    const tx = old.transaction(["docs", "operations"], "readwrite");
    tx.objectStore("docs").put({
      docId: "a",
      serializedDoc: doc("a"),
      clock: 9,
    });
    // An edit that never reached the server: the one thing in here it cannot
    // send again, so the upgrade must not drop it.
    tx.objectStore("operations").add({ docId: "a", operations: [] });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
  });
  old.close();

  const local = indexedDBProvider<JsonDoc, Operations>({ userId });
  const [clocks, pending] = await local.transaction("readonly", async (ctx) => [
    await ctx.listClocks!(),
    await ctx.getOperations({ docId: "a" }),
  ]);
  expect(clocks).toStrictEqual([{ docId: "a", clock: 9 }]);
  expect(pending).toHaveLength(1);
});

test("stops waiting on a tab that will never let go", async () => {
  const userId = crypto.randomUUID();
  // A connection with no versionchange handler: what every build before the
  // previous release opens, and what would otherwise block this one forever.
  const held = await open(`docsync-${userId}`, 1, (db) => {
    db.createObjectStore("docs", { keyPath: "docId" });
    db.createObjectStore("operations", { autoIncrement: true }).createIndex(
      "docId_idx",
      "docId",
    );
  });

  const onOutdated = vi.fn();
  const local = indexedDBProvider<JsonDoc, Operations>(
    { userId },
    { onOutdated },
  );
  await expect(
    local.transaction("readonly", (ctx) =>
      ctx.getSerializedDoc({ docId: "a" }),
    ),
  ).rejects.toThrow(OutdatedDatabaseError);
  expect(onOutdated).toHaveBeenCalledTimes(1);
  held.close();
});
