/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../index.js";

export function handleDisconnect<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("disconnect", (reason) => {
    for (const [docId, entry] of client["_docsCache"].entries()) {
      clearTimeout(entry.presenceDebounceState?.timeout);
      delete entry.presenceDebounceState;
      entry.pushStatus = "idle";
      client["_bcHelper"]?.broadcast({
        type: "PRESENCE",
        docId,
        presence: { [client["_clientId"]]: null },
      });
    }
    client["_events"].emit("disconnect", { reason });
  });
  client["_socket"].on("connect_error", (err) => {
    client["_events"].emit("disconnect", { reason: err.message });
  });
}
