import type { DocSyncClient } from "../../index.js";
import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import { getDocKey } from "./getDocKey.js";
import { loadLocalGetDocData } from "./loadLocalGetDocData.js";
import { isSyncResponseError, syncDocWithServer } from "./syncDoc.js";

export type GetDocArgs = { type: string; id: string };

export function getDoc<D extends object, S extends object, O extends object>(
  docSync: DocSyncClient<D, S, O>,
  args: GetDocArgs,
) {
  const queryKey = getDocKey(args);

  return {
    queryKey,
    retry: (failureCount: number, error: unknown) => {
      if (isSyncResponseError(error)) return false;
      return failureCount < 3;
    },
    queryFn: async () => {
      // TODO: syncDocWithServer saves remote data to IndexedDB.
      // Then we read again from IndexedDB to get the updated data.
      // Maybe we should make syncDocWithServer return the updated data.
      // Prefer the live cached doc so refetches do not replace the observed instance.
      await syncDocWithServer(docSync, args);
      const cachedData = docSync.config.queryClient.getQueryData(queryKey);
      if (isExistingGetDocData(cachedData, docSync.config.docBinding)) {
        return cachedData;
      }

      return await loadLocalGetDocData(docSync, args);
    },
  };
}

export type GetDocOptions = ReturnType<typeof getDoc>;
