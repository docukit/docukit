import type { DocSyncClient } from "../../index.js";
import {
  dispatchDocQueryDisconnected,
  dispatchLocalQueryError,
} from "../../utils/dispatchDocQueryAction.js";

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
    const connectionError =
      !client["_socket"].active && reason !== "io client disconnect"
        ? new Error("The server disconnected the DocSync client")
        : undefined;
    if (connectionError) client["_connectionError"] = connectionError;
    for (const docId of client["_docsCache"].keys()) {
      dispatchDocQueryDisconnected(client, docId);
      if (connectionError) {
        dispatchLocalQueryError(client, docId, connectionError);
      }
      client["_bcHelper"]?.broadcast({
        type: "PRESENCE",
        docId,
        presence: { [client["_clientId"]]: null },
      });
    }
    client["_events"].emit("disconnect", { reason });
  });
  client["_socket"].on("connect_error", (err) => {
    if (!client["_socket"].active) {
      client["_connectionError"] = err;
    }
    for (const docId of client["_docsCache"].keys()) {
      dispatchDocQueryDisconnected(client, docId);
      if (!client["_socket"].active) {
        dispatchLocalQueryError(client, docId, err);
      }
    }
    client["_events"].emit("disconnect", { reason: err.message });
  });
}
