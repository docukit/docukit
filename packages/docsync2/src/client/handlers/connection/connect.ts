import { onlineManager } from "@tanstack/query-core";
import type { DocSyncClient } from "../../index.js";
import { invalidateDocs } from "../../utils/invalidateDoc.js";
import { flushLocalOperations } from "../../utils/flushLocalOperations.js";

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
    void client["_queryClient"].resumePausedMutations();
    client["_events"].emit("connect");
    void (async () => {
      await Promise.all(
        [...client["_localOpsBatchState"].keys()].map((docId) =>
          flushLocalOperations(client, docId, { invalidate: false }),
        ),
      );
      await invalidateDocs(client);
    })();
  });
};
