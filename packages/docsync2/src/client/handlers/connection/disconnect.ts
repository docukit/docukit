import { onlineManager } from "@tanstack/query-core";
import type { DocSyncClient } from "../../index.js";

export const handleDisconnect = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
}: {
  client: DocSyncClient<D, S, O>;
}) => {
  client["_socket"].on("disconnect", (reason) => {
    onlineManager.setOnline(false);
    client["_events"].emit("disconnect", { reason });
  });
  client["_socket"].on("connect_error", (error) => {
    onlineManager.setOnline(false);
    client["_events"].emit("disconnect", { reason: error.message });
  });
};
