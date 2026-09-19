import { openDB, type DBSchema } from "idb";
import type { SerializedDocPayload } from "../../shared/types.js";
import type { ClientProvider, Identity } from "../types.js";

/**
 * The version this build knows how to read. Raise it whenever the stores or
 * indexes below change.
 */
const SCHEMA_VERSION = 2;

/**
 * Raised once the local database is no longer one this build can use: another
 * tab running a newer build upgraded it, or it was already newer when this tab
 * started. Nothing here can recover from that — the schema belongs to code this
 * tab does not have — so the tab has to reload.
 */
export class OutdatedDatabaseError extends Error {
  constructor(dbName: string) {
    super(
      `Local database ${dbName} belongs to a newer build of this app. Reload this tab to use it.`,
    );
    this.name = "OutdatedDatabaseError";
  }
}

export type IndexedDBProviderOptions = {
  /**
   * Called once, as soon as the database turns out to belong to a newer build.
   * Reloading the tab is the only thing that helps, so wire this to however the
   * application already asks for a reload after a deployment. Every transaction
   * from that point on rejects with `OutdatedDatabaseError`.
   */
  onOutdated?: () => void;
};

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
  { onOutdated }: IndexedDBProviderOptions = {},
): ClientProvider<S, O> {
  // Each user gets their own database for isolation and performance.
  const dbName = `docsync-${identity.userId}`;
  let outdated = false;
  // Turning outdated has to interrupt whatever is waiting on the connection,
  // not only refuse the next call: an open that is waiting on another tab does
  // not settle on its own.
  let giveUp: () => void;
  const givenUp = new Promise<never>((_, reject) => {
    giveUp = () => {
      reject(new OutdatedDatabaseError(dbName));
    };
  });
  void givenUp.catch(() => {
    // Rejected on purpose, and reported to whoever is waiting on it below.
  });

  function markOutdated() {
    if (outdated) return;
    outdated = true;
    onOutdated?.();
    giveUp();
  }

  const dbPromise = openDB<DocNodeIDB<S, O>>(dbName, SCHEMA_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // Declares the shape it wants rather than the steps from an earlier one:
      // creating only what is missing lands in the same place from a database
      // that has none of it, all of it, or the part a previous version made.
      const docs = db.objectStoreNames.contains("docs")
        ? tx.objectStore("docs")
        : db.createObjectStore("docs", { keyPath: "docId" });
      if (!docs.indexNames.contains("clock_idx"))
        docs.createIndex("clock_idx", "clock");

      const operations = db.objectStoreNames.contains("operations")
        ? tx.objectStore("operations")
        : db.createObjectStore("operations", { autoIncrement: true });
      if (!operations.indexNames.contains("docId_idx"))
        operations.createIndex("docId_idx", "docId");
    },
    blocked() {
      // A tab from before the handler below will never let go, so stop waiting
      // on it rather than leaving every read behind an open that never
      // resolves. Reloading that tab is what clears it.
      markOutdated();
    },
    blocking(_oldVersion, _newVersion, event) {
      // A tab on a newer build is waiting to change this database's version,
      // and a browser will not let it while this connection is open — for as
      // long as this tab lives, with every later open queueing behind it. Let
      // go at once, and say so: what it puts there afterwards belongs to a
      // schema this build does not know.
      (event.target as IDBDatabase | null)?.close();
      markOutdated();
    },
  });

  return {
    async transaction(mode, callback) {
      if (outdated) throw new OutdatedDatabaseError(dbName);
      const db = await Promise.race([dbPromise, givenUp]).catch(
        (cause: unknown) => {
          // Asking for a version below the one on disk is refused, which means
          // the database was already a newer build's when this tab started.
          // Asking for a version below the one on disk is refused, which
          // means the database was already a newer build's when this tab
          // started.
          if (cause instanceof DOMException && cause.name === "VersionError") {
            markOutdated();
            throw new OutdatedDatabaseError(dbName);
          }
          throw cause;
        },
      );
      if (outdated) throw new OutdatedDatabaseError(dbName);

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
