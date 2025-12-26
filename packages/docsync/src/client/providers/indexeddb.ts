import { openDB, type IDBPDatabase } from "idb";
import type { ClientProvider } from "../types.js";
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

  async getSerializedDoc(docId: string) {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readonly");
    const store = tx.objectStore("docs");
    const result = await store.get(docId);
    await tx.done;
    return result;
  }

  async saveSerializedDoc(serializedDocPayload: SerializedDocPayload<S>) {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readwrite");
    const store = tx.objectStore("docs");
    await store.put(serializedDocPayload);
    await tx.done;
  }

  async cleanDB() {
    const db = await this._dbPromise;
    const tx = db.transaction(["docs", "operations"], "readwrite");
    await tx.objectStore("docs").clear();
    await tx.objectStore("operations").clear();
    await tx.done;
  }

  async saveOperations({ docId, operations }: OpsPayload<O>) {
    const [db, getSeq] = await Promise.all([
      this._dbPromise,
      this._seqGeneratorPromise,
    ]);
    const tx = db.transaction("operations", "readwrite");
    const store = tx.objectStore("operations");
    // Compound key: [docId, seq]
    await store.add(operations, [docId, getSeq()]);
    await tx.done;
  }

  async getOperations({ docId }: { docId: string }) {
    // This should probably be here:
    // Group operations by docId (this saves work for the server)
    // const groupedOps = ops.reduce((acc, curr) => {
    //   const existing = acc.get(curr.i);
    //   if (existing) {
    //     existing.o.push(...curr.o);
    //   } else {
    //     acc.set(curr.i, { i: curr.i, o: curr.o });
    //   }
    //   return acc;
    // }, new Map<DocNodeIDB["operations"]["value"]["i"], DocNodeIDB["operations"]["value"]>());
    // Convert grouped ops back to array
    // const consolidatedOps = Array.from(groupedOps.values());
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readonly");
    const store = tx.objectStore("operations");
    // Query by docId prefix using IDBKeyRange
    const range = IDBKeyRange.bound([docId], [docId, []]);
    const results = await store.getAll(range);
    await tx.done;
    return results; // Already O[], no transformation needed
  }

  async deleteOperations({ docId, count }: { docId: string; count: number }) {
    if (count <= 0) return;
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readwrite");
    const store = tx.objectStore("operations");
    const range = IDBKeyRange.bound([docId], [docId, []]);
    try {
      let cursor = await store.openCursor(range);
      let deletedCount = 0;
      while (cursor && deletedCount < count) {
        await cursor.delete();
        deletedCount++;
        cursor = await cursor.continue();
      }
      await tx.done;
    } catch (error) {
      tx.abort();
      throw error;
    }
  }
}
