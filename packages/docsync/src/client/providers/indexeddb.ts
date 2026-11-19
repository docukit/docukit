import { openDB, type DBSchema } from "idb";
import type { SerializedDocPayload } from "../../shared/types.js";
import type { ClientProvider, Identity } from "../types.js";

// Bump when stores or indexes change. For migration policies, see
// https://github.com/docukit/docukit/pull/81
const SCHEMA = 3;

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
  serverOperations: {
    key: [string, number]; // [docId, clock]
    value: { docId: string; clock: number; operations: O[] };
  };
}

const serverOperationsUpTo = (docId: string, clock: number) =>
  IDBKeyRange.bound([docId, -Infinity], [docId, clock]);

/**
 * IndexedDB-backed client provider.
 */
export function indexedDBProvider<S extends object, O extends object>(
  identity: Identity,
): ClientProvider<S, O> {
  // Each user gets their own database for isolation and performance.
  const dbName = `docsync:v${SCHEMA}:${identity.userId}`;
  const dbPromise = openDB<DocNodeIDB<S, O>>(dbName, 1, {
    upgrade(db) {
      const docs = db.createObjectStore("docs", { keyPath: "docId" });
      docs.createIndex("clock_idx", "clock");
      const operationsStore = db.createObjectStore("operations", {
        autoIncrement: true,
      });
      operationsStore.createIndex("docId_idx", "docId");
      db.createObjectStore("serverOperations", { keyPath: ["docId", "clock"] });
    },
  });

  return {
    async transaction(mode, callback) {
      const db = await dbPromise;

      // Cast as readwrite to support all context operations in compile time
      const tx = db.transaction(
        ["docs", "operations", "serverOperations"],
        mode as "readwrite",
      );

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
            // Server batches stored after a snapshot take its doc further.
            // Their keys are [docId, clock], so the last one of a doc wins.
            const byDocId = new Map(
              clocks.map((entry) => [entry.docId, entry]),
            );
            let batch = await tx
              .objectStore("serverOperations")
              .openKeyCursor();
            let moved = false;
            while (batch) {
              const [docId, clock] = batch.key;
              const entry = byDocId.get(docId);
              if (entry && clock > entry.clock) {
                entry.clock = clock;
                moved = true;
              }
              batch = await batch.continue();
            }
            if (moved) {
              clocks.sort(
                (a, b) =>
                  a.clock - b.clock ||
                  (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0),
              );
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

          async getServerOperations({ docId }) {
            const batches = await tx
              .objectStore("serverOperations")
              .getAll(serverOperationsUpTo(docId, Infinity));
            return batches.map(({ clock, operations }) => ({
              clock,
              operations,
            }));
          },

          async countServerOperations({ docId }) {
            const store = tx.objectStore("serverOperations");
            const range = serverOperationsUpTo(docId, Infinity);
            const [count, last] = await Promise.all([
              store.count(range),
              store.openKeyCursor(range, "prev"),
            ]);
            return { count, lastClock: last?.key[1] };
          },

          async saveServerOperations(batch) {
            await tx.objectStore("serverOperations").put(batch);
          },

          async deleteServerOperations({ docId, clock }) {
            await tx
              .objectStore("serverOperations")
              .delete(serverOperationsUpTo(docId, clock));
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
