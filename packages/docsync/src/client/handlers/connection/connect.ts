/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../index.js";
import { handleSync } from "../clientInitiated/sync.js";

export function handleConnect<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("connect", () => {
    client["_events"].emit("connect");
    for (const docId of client["_docsCache"].keys()) {
      void handleSync(client, docId);
    }
  });
}
