/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../index.js";

export function handleConnect<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("connect", () => {
    client["_emit"](client["_connectEventListeners"]);
    for (const docId of client["_docsCache"].keys()) {
      client.saveRemote({ docId });
    }
  });
}
