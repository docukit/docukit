import { onlineManager } from "@tanstack/query-core";
import type { DocSyncClient } from "../../index.js";
import { invalidateActiveGetDocQueries } from "../../utils/setupQueryClient/invalidateActiveGetDocQueries.js";

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
    onlineManager.setOnline(true);
    void client.config.queryClient.resumePausedMutations();
    client["_events"].emit("connect");
    invalidateActiveGetDocQueries(client);
  });
};
