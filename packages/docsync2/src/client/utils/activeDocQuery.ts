import type { DocSyncClient } from "../index.js";
import { getDocArgsFromKey } from "../queries/getDoc/getDocKey.js";

export const activeDocIds = <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
) => {
  const docIds = new Set<string>();
  for (const query of docSync["_queryClient"].getQueryCache().getAll()) {
    if (query.getObserversCount() === 0) continue;

    const docArgs = getDocArgsFromKey(query.queryKey);
    if (docArgs) docIds.add(docArgs.id);
  }

  return docIds;
};

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
