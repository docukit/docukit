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
  const newer = await open(`docsync-${userId}`, 2);
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
