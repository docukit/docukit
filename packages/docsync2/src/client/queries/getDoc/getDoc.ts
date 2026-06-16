import type { DocSyncClient } from "../../index.js";
import { getDocKey } from "./getDocKey.js";
import { isSyncResponseError, syncDocWithServer } from "./syncDoc.js";

export type GetDocArgs = {
  type: string;
  id: string;
  createIfMissing?: boolean;
};

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
    meta: { createIfMissing: args.createIfMissing === true },
    queryFn: () => syncDocWithServer(docSync, args),
  };
}

export type GetDocOptions = ReturnType<typeof getDoc>;
