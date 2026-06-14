import type { DocSyncClient } from "../../index.js";
import {
  getDocArgsFromKey,
  type GetDocKeyArgs,
} from "../../queries/getDoc/getDocKey.js";

export const invalidateActiveGetDocQueries = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  predicate?: (args: GetDocKeyArgs) => boolean,
) => {
  const { queryClient } = client.config;

  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.getObserversCount() === 0) continue;

    const args = getDocArgsFromKey(query.queryKey);
    if (!args) continue;
    if (predicate && !predicate(args)) continue;

    void queryClient.invalidateQueries(
      { queryKey: query.queryKey, exact: true, refetchType: "active" },
      { cancelRefetch: false },
    );
  }
};
