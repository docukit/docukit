import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SerializedDocPayload } from "../../shared/types.js";
import type { ClientProvider, Identity } from "../types.js";

/**
 * Part of the database name, not its version. Raise it whenever the stores or
 * indexes below change, and this opens a new database rather than changing the
 * one in use.
 *
 * Changing a version is the one thing a browser refuses to do while another
 * connection is open, and it refuses for as long as the tab holding it lives,
 * with every later open on that database waiting behind the attempt. That tab
 * runs a build this one cannot coordinate with. Opening a name nobody else has
 * cannot be refused by anyone, so a schema change costs a fresh cache instead
 * of a tab that will not load.
 *
 * Everything in a fresh cache comes back from the server except operations
 * that were never uploaded, which is why those are moved over below.
 */
const SCHEMA = 2;

const databaseName = (userId: string, schema = SCHEMA) =>
  schema === 1 ? `docsync-${userId}` : `docsync-${userId}-${schema}`;

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
  const dbName = databaseName(identity.userId);
  const dbPromise = openDB<DocNodeIDB<S, O>>(dbName, 1, {
    upgrade(db) {
      const docs = db.createObjectStore("docs", { keyPath: "docId" });
      docs.createIndex("clock_idx", "clock");
      const operationsStore = db.createObjectStore("operations", {
        autoIncrement: true,
      });
      operationsStore.createIndex("docId_idx", "docId");
    },
  });
  void drainPreviousSchemas(identity.userId, dbPromise);

  return {
    async transaction(mode, callback) {
      const db = await dbPromise;

      // Cast as readwrite to support all context operations in compile time
      const tx = db.transaction(["docs", "operations"], mode as "readwrite");

      try {
        const result = await callback({
          async listClocks(arg) {
            // Reads index entries, never records. An entry holds the clock and
            // the document id, so no document is deserialised to find out
            // which version of it is stored.
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

/**
 * Moves operations that were never uploaded out of the databases earlier
 * schemas used, and asks for those databases to be dropped.
 *
 * Only operations are worth moving: a snapshot comes back from the server, and
 * an unsent operation does not exist anywhere else. Reading and writing both
 * happen at the version already on disk, which no connection can refuse.
 *
 * The drop runs once nothing holds the database, which is immediately when no
 * tab is left on that schema, and otherwise the moment the last one closes or
 * reloads. Until then this runs again on every start, so anything that tab
 * writes in the meantime is picked up by the next one. What can still be lost
 * is an operation it writes after the last start and never manages to upload,
 * which needs it to be offline for that whole stretch.
 *
 * Writing before removing means a crash in between repeats a batch, which
 * applies as a no-op. Removing a batch another client already acknowledged does
 * nothing, which its store guarantees.
 */
async function drainPreviousSchemas<S extends object, O extends object>(
  userId: string,
  current: Promise<IDBPDatabase<DocNodeIDB<S, O>>>,
) {
  // Listing avoids opening names that were never used, which would create them.
  // Where it is unavailable there is nothing to move: this is the first schema
  // that browser has seen.
  const existing = new Set(
    ((await indexedDB.databases?.()) ?? []).map(({ name }) => name),
  );
  for (let schema = SCHEMA - 1; schema >= 1; schema--) {
    const name = databaseName(userId, schema);
    if (!existing.has(name)) continue;
    let previous;
    try {
      // No version, so this opens what is there and cannot be refused.
      previous = await openDB(name);
      if (!previous.objectStoreNames.contains("operations")) continue;
      const keys = await previous.getAllKeys("operations");
      const batches = await previous.getAll("operations");
      if (batches.length === 0) continue;

      const db = await current;
      const adopt = db.transaction("operations", "readwrite");
      for (const batch of batches as Array<{ docId: string; operations: O[] }>)
        await adopt.store.add(batch);
      await adopt.done;

      const release = previous.transaction("operations", "readwrite");
      for (const key of keys) await release.store.delete(key);
      await release.done;
    } catch {
      // An unreadable database is not worth failing a session over. Its
      // documents come back from the server, and the next start tries again.
    } finally {
      // Ours has to go before the drop can run at all; the only connection
      // left to wait for is then a tab still on that schema.
      previous?.close();
      indexedDB.deleteDatabase(name);
    }
  }
}
