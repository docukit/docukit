import type { DocSyncCore } from "../core.js";

export function getLocalDocVersion<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncCore<D, S, O>, docId: string): number {
  return client["_docsCache"].get(docId)?.localVersion ?? 0;
}

export function markLocalDocChanged<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncCore<D, S, O>, docId: string): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  cacheEntry.localVersion += 1;
}
