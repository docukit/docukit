import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SerializedDocPayload } from "../../shared/types.js";
import type { ClientProvider, Identity } from "../types.js";

// Bump when stores or indexes change. Each schema starts with empty local
// storage; snapshots and unsent operations from other schemas are not carried over.
const SCHEMA = 2;

interface DocNodeIDB<S extends object, O extends object> extends DBSchema {
  docs: {
    key: string; // docId
    value: SerializedDocPayload<S>;
    indexes: { clock_idx: number };
  };
  operations: {
    key: number;
    value: { operations: O[]; docId: string };
    indexes: { docId_idx: string };
  };
}

/**
 * IndexedDB-backed client provider.
 */
export function indexedDBProvider<S extends object, O extends object>(
  identity: Identity,
): ClientProvider<S, O> {
  // Each user gets their own database for isolation and performance.
  const dbName = `docsync:v${SCHEMA}:${identity.userId}`;
  const dbPromise: Promise<IDBPDatabase<DocNodeIDB<S, O>>> = openDB(dbName, 1, {
    upgrade(db) {
      const docs = db.createObjectStore("docs", { keyPath: "docId" });
      docs.createIndex("clock_idx", "clock");
      const operationsStore = db.createObjectStore("operations", {
        autoIncrement: true,
      });
      operationsStore.createIndex("docId_idx", "docId");
    },
  });

  return {
    async transaction(mode, callback) {
      const db = await dbPromise;

      // Cast as readwrite to support all context operations in compile time
      const tx = db.transaction(["docs", "operations"], mode as "readwrite");

      try {
        const result = await callback({
          async listClocks(arg) {
            const wanted = arg?.docIds && new Set(arg.docIds);
            const clocks: Array<{ docId: string; clock: number }> = [];
            let cursor = await tx
              .objectStore("docs")
              .index("clock_idx")
              .openKeyCursor();
            while (cursor) {
              if (!wanted || wanted.has(cursor.primaryKey))
                clocks.push({ docId: cursor.primaryKey, clock: cursor.key });
              cursor = await cursor.continue();
            }
            return clocks;
          },

          async getSerializedDoc({ docId }) {
            const store = tx.objectStore("docs");
            return await store.get(docId);
          },

          async saveSerializedDoc(payload) {
            const store = tx.objectStore("docs");
            await store.put(payload);
          },

          async getOperations({ docId }) {
            // TODO: maybe I should add a docbinding.mergeOperations call here?
            const store = tx.objectStore("operations");
            const index = store.index("docId_idx");
            // A cursor reads each batch together with the key the store gave
            // it, so the id always belongs to the operations next to it.
            const batches = [];
            let cursor = await index.openCursor(IDBKeyRange.only(docId));
            while (cursor) {
              batches.push({
                id: cursor.primaryKey,
                operations: cursor.value.operations,
              });
              cursor = await cursor.continue();
            }
            return batches;
          },

          async saveOperations({ docId, operations }) {
            const store = tx.objectStore("operations");
            await store.add({ operations, docId });
          },

          async deleteOperations({ ids }) {
            const store = tx.objectStore("operations");
            await Promise.all(ids.map((id) => store.delete(id)));
          },
        });
        await tx.done;
        return result;
      } catch (error) {
        // Transaction auto-aborts on error; swallow tx.done rejection
        tx.done.catch(() => void 0);
        throw error;
      }
    },
  };
}
