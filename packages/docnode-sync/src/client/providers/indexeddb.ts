import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  type Doc,
  type DocNode,
  type JsonDoc,
  type Operations,
  type RootNode,
} from "docnode";
import type { ClientProvider } from "../index.js";
// TODO: import from core

export interface DocNodeDB extends DBSchema {
  docs: {
    key: string;
    value: { i?: string; d: JsonDoc };
    indexes: {
      id_idx: string;
      clock_idx: number;
    };
  };
  operations: {
    key: number;
    value: { i?: string; o: Operations };
  };
}

// TODO: maybe this should be a set of functions to make it tree-shakable
// DocNodeWorker doesn't need the same methods as DocNodeClient
export class IndexedDBProvider implements ClientProvider {
  private _dbPromise: Promise<IDBPDatabase<DocNodeDB>>;

  constructor() {
    this._dbPromise = openDB("docnode", 1, {
      upgrade(db) {
        if (db.objectStoreNames.contains("docs")) return;

        // Docs store
        const store = db.createObjectStore("docs", {
          keyPath: "i",
        });
        store.createIndex("id_idx", "i");
        store.createIndex("clock_idx", "clock");

        // Operations store
        db.createObjectStore("operations", { autoIncrement: true });
      },
    });
  }

  async getJsonDoc(docId: string): Promise<JsonDoc> {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readonly");
    const store = tx.objectStore("docs");
    const index = store.index("id_idx");
    const results = await index.get(docId);
    await tx.done;
    const defaultRoot: ReturnType<DocNode<typeof RootNode>["toJSON"]> = [
      "TODO",
      "root",
      { namespace: '"indexDoc"' },
    ];
    return results?.d ?? defaultRoot;
  }

  async saveOnChange(doc: Doc, afterSave: () => void) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    doc.onChange(async ({ operations }) => {
      const db = await this._dbPromise;

      // save doc
      const jsonDoc = doc.toJSON();
      const tx1 = db.transaction("docs", "readwrite");
      const docStore = tx1.objectStore("docs");
      const storedDoc = { i: doc.root.id, d: jsonDoc };
      await docStore.put(storedDoc);
      tx1.onerror = (event) => {
        console.error("Error saving to IndexedDB", event);
      };
      await tx1.done;

      // save operations
      const tx2 = db.transaction("operations", "readwrite");
      const operationsStore = tx2.objectStore("operations");
      const storedOperations = { i: doc.root.id, o: operations };
      await operationsStore.add(storedOperations);
      tx2.onerror = (event) => {
        console.error("Error saving to IndexedDB", event);
      };
      await tx2.done;

      afterSave();
    });
  }

  async cleanDB() {
    const db = await this._dbPromise;
    const tx = db.transaction("docs", "readwrite");
    const store = tx.objectStore("docs");
    await store.clear();
    await tx.done;
  }

  async saveOperations(_operations: Operations) {
    throw new Error("no definido");
  }

  async mergeAndDeleteOperations(_operations: Operations) {
    throw new Error("no definido");
  }

  async getOperations(): Promise<Operations> {
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

    throw new Error("fix with the new return type");
    const db = await this._dbPromise;
    const tx = db.transaction("operations", "readonly");
    const store = tx.objectStore("operations");
    const _results = await store.getAll();
    await tx.done;
    // return results;
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
