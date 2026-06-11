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
    client["_events"].emit("disconnect", { reason });
  });
  client["_socket"].on("connect_error", (error) => {
    client["_events"].emit("disconnect", { reason: error.message });
  });
};
