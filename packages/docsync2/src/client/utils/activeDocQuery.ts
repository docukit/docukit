import type { DocSyncClient } from "../index.js";
import { getDocArgsFromKey } from "../queries/getDoc/getDocKey.js";

export const hasActiveDocQuery = <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  docId: string,
) => {
  return docSync["_queryClient"]
    .getQueryCache()
    .getAll()
    .some((query) => {
      const docArgs = getDocArgsFromKey(query.queryKey);
      return docArgs?.id === docId && query.getObserversCount() > 0;
    });
};

export const ensureActiveDocQuery = <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  docId: string,
) => {
  if (!hasActiveDocQuery(docSync, docId)) {
    throw new Error(`Doc ${docId} is not loaded, cannot set presence`);
  }
};
