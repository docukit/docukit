import type { DocSyncClient } from "../index.js";
import { getDocArgsFromKey } from "../queries/getDoc/getDocKey.js";

export const invalidateDocs = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
) =>
  client["_config"].queryClient.invalidateQueries({
    queryKey: ["docsync", "doc"],
  });

export const invalidateDoc = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
) =>
  client["_config"].queryClient.invalidateQueries({
    queryKey: ["docsync", "doc"],
    predicate: (query) => getDocArgsFromKey(query.queryKey)?.id === docId,
  });
