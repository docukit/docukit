import {
  openDB,
  type IDBPDatabase,
  type IDBPTransaction,
  type DBSchema,
} from "idb";
import type { SerializedDocPayload } from "../../shared/types.js";
import type {
  ClientProvider,
  ClientProviderContext,
  Identity,
} from "../types.js";

interface DocNodeIDB<S, O> extends DBSchema {
  docs: {
    key: string; // docId
    value: SerializedDocPayload<S>;
  };
  operations: {
    key: number;
    value: { operations: O[]; docId: string };
    indexes: { docId_idx: string };
  };
}

export class IndexedDBProvider<S, O> implements ClientProvider<S, O> {
  private _dbPromise: Promise<IDBPDatabase<DocNodeIDB<S, O>>>;

  constructor(identity: Identity) {
    // Each user gets their own database for isolation and performance
    const dbName = `docsync-${identity.userId}`;
    this._dbPromise = openDB(dbName, 1, {
      upgrade(db) {
        if (db.objectStoreNames.contains("docs")) return;
        db.createObjectStore("docs", { keyPath: "docId" });
        const operationsStore = db.createObjectStore("operations", {
          autoIncrement: true,
        });
        operationsStore.createIndex("docId_idx", "docId");
      },
    });
  }

  /**
   * Create a transaction context that wraps all operations in a single IDB transaction.
   */
  private _createContext(
    tx: IDBPTransaction<
      DocNodeIDB<S, O>,
      ("docs" | "operations")[],
      "readwrite"
    >,
  ): ClientProviderContext<S, O> {
    return {
      async getSerializedDoc(docId: string) {
        const store = tx.objectStore("docs");
        return await store.get(docId);
      },

      async saveSerializedDoc(payload: SerializedDocPayload<S>) {
        const store = tx.objectStore("docs");
        await store.put(payload);
      },

      async getOperations({ docId }: { docId: string }) {
        // TODO: maybe I should add a docbinding.mergeOperations call here?
        const store = tx.objectStore("operations");
        const index = store.index("docId_idx");
        const result = await index.getAll(docId);
        return result.map((r) => r.operations);
      },

      async saveOperations({
        docId,
        operations,
      }: {
        docId: string;
        operations: O[];
      }) {
        const store = tx.objectStore("operations");
        await store.add({ operations, docId });
      },

      async deleteOperations({
        docId,
        count,
      }: {
        docId: string;
        count: number;
      }) {
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
    };
  }

  /**
   * Run multiple operations in a single atomic transaction.
   * If any operation fails, all changes are rolled back.
   */
  async transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: ClientProviderContext<S, O>) => Promise<T>,
  ): Promise<T> {
    const db = await this._dbPromise;

    // Cast as readwrite to support all context operations in compile time
    const tx = db.transaction(["docs", "operations"], mode as "readwrite");
    const ctx = this._createContext(tx);

    try {
      const result = await callback(ctx);
      await tx.done;
      return result;
    } catch (error) {
      // Transaction auto-aborts on error; swallow tx.done rejection
      tx.done.catch(() => void 0);
      throw error;
    }
  }
}
