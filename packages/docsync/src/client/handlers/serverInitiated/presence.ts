/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../index.js";

/** Registers the socket listener for incoming presence updates from the server. */
export function handlePresence<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("presence", (payload) => {
    const cacheEntry = client["_docsCache"].get(payload.docId);
    if (!cacheEntry) return;
    client["_applyPresencePatch"](cacheEntry, payload.presence);
  });
}
