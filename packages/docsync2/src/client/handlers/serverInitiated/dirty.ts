import type { DocSyncClient } from "../../index.js";
import { handleSync } from "../clientInitiated/sync.js";
import { getDocArgsFromKey } from "../../queries/getDoc/getDocKey.js";

export const handleDirty = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
}: {
  client: DocSyncClient<D, S, O>;
}) => {
  client["_socket"].on("dirty", ({ docId }) => {
    const queries = client.config.queryClient.getQueryCache().getAll();
    for (const query of queries) {
      const args = getDocArgsFromKey(query.queryKey);
      if (args?.id === docId) void handleSync(client, args);
    }
  });
};
