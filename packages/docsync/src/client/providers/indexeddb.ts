import { openDB, type IDBPDatabase, type IDBPTransaction } from "idb";
import type { ClientProvider, TransactionContext } from "../types.js";
import { type DBSchema } from "idb";
import type { OpsPayload, SerializedDocPayload } from "../../shared/types.js";

interface DocNodeIDB<S, O> extends DBSchema {
  docs: {
    key: string; // docId
    value: SerializedDocPayload<S>;
  };
  operations: {
    key: [string, number]; // [docId, seq] - compound key
    value: O; // Just the operations, no wrapper
  };
}

type StoreNames = ("docs" | "operations")[];
type IDBTx<S, O> = IDBPTransaction<DocNodeIDB<S, O>, StoreNames, "readwrite">;

export class IndexedDBProvider<S, O> implements ClientProvider<S, O> {
  private _dbPromise: Promise<IDBPDatabase<DocNodeIDB<S, O>>>;
  private _seqGeneratorPromise: Promise<() => number>;

  constructor() {
    this._dbPromise = openDB("docsync", 1, {
      upgrade(db) {
        db.createObjectStore("docs", { keyPath: "docId" });
        db.createObjectStore("operations");
      },
    });

    // Initialize seq generator from max existing key (ensures no collisions after page refresh)
    this._seqGeneratorPromise = this._initSeqGenerator();
  }

  /**
   * Initialize the sequence generator by reading the max existing key.
   * This ensures monotonic keys even after page refresh.
   */
  private async _initSeqGenerator(): Promise<() => number> {
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readonly");
    const cursor = await tx.objectStore("operations").openCursor(null, "prev");
    const maxSeq = cursor ? cursor.key[1] : 0;
    await tx.done;

    let seq = maxSeq;
    return () => ++seq;
  }

  /**
   * Create a transaction context that wraps all operations in a single IDB transaction.
   */
  private _createContext(
    tx: IDBTx<S, O>,
    getSeq: () => number,
  ): TransactionContext<S, O> {
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
        const range = IDBKeyRange.bound([docId], [docId, []]);
        return await store.getAll(range);
      },

      async saveOperations({ docId, operations }: OpsPayload<O>) {
        const store = tx.objectStore("operations");
        await store.add(operations, [docId, getSeq()]);
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
        const range = IDBKeyRange.bound([docId], [docId, []]);
        let cursor = await store.openCursor(range);
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
    callback: (ctx: TransactionContext<S, O>) => Promise<T>,
  ): Promise<T> {
    const [db, getSeq] = await Promise.all([
      this._dbPromise,
      this._seqGeneratorPromise,
    ]);
    // Always use readwrite to support all context operations
    const tx = db.transaction(["docs", "operations"], mode as "readwrite");
    const ctx = this._createContext(tx, getSeq);

    try {
      const result = await callback(ctx);
      await tx.done;
      return result;
    } catch (error) {
      tx.abort();
      throw error;
    }
  }

  // TODO: this should be derived from other methods
  async cleanDB() {
    const db = await this._dbPromise;
    const tx = db.transaction(["docs", "operations"], "readwrite");
    await tx.objectStore("docs").clear();
    await tx.objectStore("operations").clear();
    await tx.done;
  }
}
