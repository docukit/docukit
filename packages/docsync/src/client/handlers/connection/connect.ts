import type { DocSyncClient } from "../../index.js";
import { dispatchDocQueryConnected } from "../../utils/dispatchDocQueryAction.js";
import { handleSync } from "../clientInitiated/sync/sync.js";

export function handleConnect<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("connect", () => {
    delete client["_connectionAttempt"];
    client["_connectionError"] = undefined;
    client["_connectionFetchStatus"] = "fetching";
    // Resume every loaded query before notifying connect listeners or awaiting
    // local flushes. Otherwise old subscriptions can still report `paused`
    // while subscriptions created by a connect listener report `fetching`.
    for (const docId of client["_docsCache"].keys()) {
      dispatchDocQueryConnected(client, docId);
    }
    client["_events"].emit("connect");
    void (async () => {
      const syncedDocIds = new Set<string>();
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
        const pushStatus = client["_pushStatusByDocId"].get(docId) ?? "idle";
        if (!syncedDocIds.has(docId) && pushStatus === "idle") {
          void handleSync(client, docId);
        }
      }
    })();
  });
}
