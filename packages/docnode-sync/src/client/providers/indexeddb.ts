import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { type Doc, type JsonDoc, type Operations } from "docnode";
import type { ClientProvider } from "../index.js";

export interface DocNodeDB extends DBSchema {
  docs: {
    key: string; // docId
    value: JsonDoc;
  };
  operations: {
    key: number;
    value: { i?: string; o: Operations };
    // Am I using this index?
    indexes: {
      docId_idx: string;
    };
  };
}

export class IndexedDBProvider implements ClientProvider {
  private _dbPromise: Promise<IDBPDatabase<DocNodeDB>>;

  constructor() {
    this._dbPromise = openDB("docnode", 1, {
      upgrade(db) {
        if (db.objectStoreNames.contains("docs")) return;
        db.createObjectStore("docs");
        const operationsStore = db.createObjectStore("operations", {
          autoIncrement: true,
        });
        operationsStore.createIndex("docId_idx", "i");
      },
    });
  }

  async getJsonDoc(docId: string): Promise<JsonDoc | undefined> {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readonly");
    const store = tx.objectStore("docs");
    const result = await store.get(docId);
    await tx.done;
    return result;
  }

  async saveJsonDoc(json: JsonDoc, docId: string) {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readwrite");
    const store = tx.objectStore("docs");
    await store.put(json, docId);
    await tx.done;
  }

  async cleanDB() {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readwrite");
    const store = tx.objectStore("docs");
    await store.clear();
    await tx.done;
  }

  async saveOperations(operations: Operations, docId: string) {
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readwrite");
    const store = tx.objectStore("operations");
    await store.add({ i: docId, o: operations });
    await tx.done;
  }

  async getOperations() {
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
    // }, new Map<DocNodeDB["operations"]["value"]["i"], DocNodeDB["operations"]["value"]>());
    // Convert grouped ops back to array
    // const consolidatedOps = Array.from(groupedOps.values());
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readonly");
    const store = tx.objectStore("operations");
    const results = await store.getAll();
    await tx.done;
    return results;
  }

  async deleteOperations(count: number) {
    if (count <= 0) return;
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readwrite");
    const store = tx.objectStore("operations");
    try {
      const cursor = await store.openCursor();
      let deletedCount = 0;
      while (cursor && deletedCount < count) {
        await cursor.delete();
        await cursor.continue();
        deletedCount++;
      }
      await tx.done;
    } catch (error) {
      tx.abort();
      throw error;
    }
  }
}
