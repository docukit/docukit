import type { DocSyncClient } from "../../index.js";
import { handleUnsubscribeDoc } from "../../handlers/clientInitiated/unsubscribe.js";

export async function unloadDoc<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(client: DocSyncClient<D, S, O>, docId: string): Promise<void> {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  if (cacheEntry.refCount > 1) {
    cacheEntry.refCount -= 1;
    client["_events"].emit("docUnload", {
      docId,
      refCount: cacheEntry.refCount,
    });
  } else {
    cacheEntry.refCount = 0;
    client["_events"].emit("docUnload", { docId, refCount: 0 });

    // Dispose when promise resolves
    const doc = await cacheEntry.promisedDoc;
    const currentEntry = client["_docsCache"].get(docId);
    if (currentEntry?.refCount === 0) {
      if (currentEntry.localOpsBatchState)
        clearTimeout(currentEntry.localOpsBatchState.timeout);
      if (currentEntry.presenceDebounceState)
        clearTimeout(currentEntry.presenceDebounceState.timeout);
      client["_docsCache"].delete(docId);
      if (doc && doc !== "deleted") {
        await handleUnsubscribeDoc(client, { docId });
        client["_docBinding"].dispose(doc);
      }
    }
  }
}
