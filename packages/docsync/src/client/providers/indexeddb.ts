/* eslint-disable @typescript-eslint/no-explicit-any */
import { openDB, type DBSchema } from "idb";
import type { SerializedDocPayload } from "../../shared/types.js";
import type { ClientProvider, Identity } from "../types.js";

interface DocNodeIDB extends DBSchema {
  docs: {
    key: string; // docId
    value: SerializedDocPayload<unknown>;
  };
  operations: {
    key: number;
    value: { operations: unknown[]; docId: string };
    indexes: { docId_idx: string };
  };
}

/**
 * IndexedDB-backed client provider.
 */
export function indexedDBProvider(
  identity: Identity,
): ClientProvider<any, any> {
  // Each user gets their own database for isolation and performance.
  const dbName = `docsync-${identity.userId}`;
  const dbPromise = openDB<DocNodeIDB>(dbName, 1, {
    upgrade(db) {
      if (db.objectStoreNames.contains("docs")) return;
      db.createObjectStore("docs", { keyPath: "docId" });
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
            const result = await index.getAll(docId);
            return result.map((r) => r.operations);
          },

          async saveOperations({ docId, operations }) {
            const store = tx.objectStore("operations");
            await store.add({ operations, docId });
          },

          async deleteOperations({ docId, count }) {
            if (count <= 0) return;
            const store = tx.objectStore("operations");
            const index = store.index("docId_idx");
            let cursor = await index.openCursor(IDBKeyRange.only(docId));
            let deletedCount = 0;
            while (cursor && deletedCount < count) {
              await cursor.delete();
              deletedCount++;
              cursor = await cursor.continue();
            }
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
