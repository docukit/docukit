import { onlineManager } from "@tanstack/query-core";
import type { DocSyncClient } from "../../index.js";
import { invalidateDocs } from "../../utils/invalidateDoc.js";

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
    void client["_config"].queryClient.resumePausedMutations();
    client["_events"].emit("connect");
    void invalidateDocs(client);
  });
};
