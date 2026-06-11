import type { DocSyncClient } from "../../index.js";
import { handleSync } from "../clientInitiated/sync.js";
import { getDocArgsFromKey } from "../../queries/getDoc/getDocKey.js";

export const handleConnect = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
}: {
  client: DocSyncClient<D, S, O>;
}) => {
  client["_socket"].on("connect", () => {
    client["_events"].emit("connect");
    const queries = client.config.queryClient.getQueryCache().getAll();
    for (const query of queries) {
      const args = getDocArgsFromKey(query.queryKey);
      if (args) void handleSync(client, args);
    }
  });
};
