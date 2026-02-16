/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../index.js";

type DisconnectDeps<D extends {} = {}, S extends {} = {}, O extends {} = {}> = {
  client: DocSyncClient<D, S, O>;
};

export function handleDisconnect<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: DisconnectDeps<D, S, O>): void {
  client["_socket"].on("disconnect", (reason) => {
    client["_pushStatusByDocId"].clear();
    for (const state of client["_presenceDebounceState"].values()) {
      clearTimeout(state.timeout);
    }
    client["_presenceDebounceState"].clear();
    for (const docId of client["_docsCache"].keys()) {
      // Bracket notation required to access protected method from handler
      // eslint-disable-next-line @typescript-eslint/dot-notation
      client["_sendMessage"]({
        type: "PRESENCE",
        docId,
        presence: { [client["_clientId"]]: null },
      });
    }
    client["_emit"](client["_disconnectEventListeners"], { reason });
  });
  client["_socket"].on("connect_error", (err) => {
    client["_emit"](client["_disconnectEventListeners"], {
      reason: err.message,
    });
  });
}
