import type { DocSyncClient } from "../../index.js";
import { handleSync } from "../clientInitiated/sync.js";

export function handleDirty<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("dirty", (payload) => {
    void handleSync(client, payload.docId);
  });
}
