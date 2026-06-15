import type { DocSyncClient } from "../../index.js";

export function handleDisconnect<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("disconnect", (reason) => {
    client["_pushStatusByDocId"].clear();
    client["_collabDocIds"].clear();
    for (const state of client["_presenceDebounceState"].values()) {
      clearTimeout(state.timeout);
      delete state.timeout;
    }
    for (const docId of client["_docsCache"].keys()) {
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
