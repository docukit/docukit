/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../index.js";
import { handleSync } from "../clientInitiated/sync.js";

export function handleDirty<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("dirty", (payload) => {
    void handleSync(client, payload.docId);
  });
}
