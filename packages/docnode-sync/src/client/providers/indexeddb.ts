import { openDB, type IDBPDatabase } from "idb";
import type { ClientProvider } from "../index.js";
import { type DBSchema } from "idb";
import type { JsonDocPayload, OpsPayload } from "../../shared/types.js";

interface DocNodeIDB extends DBSchema {
  docs: {
    key: string; // docId
    value: JsonDocPayload;
  };
  operations: {
    key: number;
    value: OpsPayload;
    // For the moment, we're not using this index.
    // indexes: {
    //   docId_idx: string;
    // };
  };
}

export class IndexedDBProvider implements ClientProvider {
  private _dbPromise: Promise<IDBPDatabase<DocNodeIDB>>;

  constructor() {
    this._dbPromise = openDB("docnode", 1, {
      upgrade(db) {
        if (db.objectStoreNames.contains("docs")) return;
        db.createObjectStore("docs");
        db.createObjectStore("operations", {
          autoIncrement: true,
        });
        // operationsStore.createIndex("docId_idx", "docId");
      },
    });
  }

  async getJsonDoc(docId: string): Promise<JsonDocPayload | undefined> {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readonly");
    const store = tx.objectStore("docs");
    const result = await store.get(docId);
    await tx.done;
    return result;
  }

  async saveJsonDoc(json: JsonDocPayload) {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readwrite");
    const store = tx.objectStore("docs");
    await store.put(json, json.jsonDoc[0]);
    await tx.done;
  }

  async cleanDB() {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readwrite");
    const store = tx.objectStore("docs");
    await store.clear();
    await tx.done;
  }

  async saveOperations(ops: OpsPayload) {
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readwrite");
    const store = tx.objectStore("operations");
    await store.add(ops);
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
    // }, new Map<DocNodeIDB["operations"]["value"]["i"], DocNodeIDB["operations"]["value"]>());
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
