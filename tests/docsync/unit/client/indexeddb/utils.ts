import { onTestFinished } from "vitest";

export const openPreviousDatabase = (userId: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`docsync-${userId}`, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("docs", { keyPath: "docId" });
      db.createObjectStore("operations", { autoIncrement: true }).createIndex(
        "docId_idx",
        "docId",
      );
    };
    request.onsuccess = () => {
      onTestFinished(() => request.result.close());
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });

export const transactionDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
