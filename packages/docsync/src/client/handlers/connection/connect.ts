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
    void (async () => {
      const syncedDocIds = new Set<string>();
      // TODO: This is defensive for long debounces; consider debouncing only server sync, not local IDB persistence.
      await Promise.all(
        [...client["_localOpsBatchState"].keys()].map(async (docId) => {
          const didFlush = await client["_flushLocalOperations"](docId, {
            sync: false,
          });
          if (didFlush) {
            syncedDocIds.add(docId);
            void handleSync(client, docId);
          }
        }),
      );

      for (const docId of client["_docsCache"].keys()) {
        if (!syncedDocIds.has(docId)) void handleSync(client, docId);
      }
    })();
  });
}
