/** Seed browser storage to simulate separate installations in one test page. */
export const withMetadataStore = <T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => Pick<IDBRequest<T>, "result">,
) =>
  new Promise<T>((resolve, reject) => {
    const opening = indexedDB.open("docsync:metadata", 1);
    opening.onupgradeneeded = () =>
      opening.result.createObjectStore("metadata");
    opening.onerror = () =>
      reject(opening.error ?? new Error("Metadata database failed to open"));
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("metadata", mode);
      const request = callback(tx.objectStore("metadata"));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error("Metadata transaction aborted"));
      };
    };
  });

export const seedMetadata = (userId?: string, deviceId?: string) =>
  withMetadataStore("readwrite", (store) => {
    if (deviceId) store.put(deviceId, "deviceId");
    return userId ? store.put(userId, "userId") : store.delete("userId");
  });

export const readMetadata = (key: string): Promise<unknown> =>
  withMetadataStore("readonly", (store) => store.get(key));
