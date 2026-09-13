import type { DocSyncClient } from "../../index.js";
import { dispatchAllDocQueriesConnected } from "../../utils/dispatchDocQueryAction.js";
import { handleSubscribe } from "../clientInitiated/subscribe.js";
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
    dispatchAllDocQueriesConnected(client);
    client["_events"].emit("connect");
    void (async () => {
      // Persist every pending batch first so the syncs below push it. A doc
      // whose sync is already running just gets a rerun; nothing starts twice.
      await Promise.all(
        [...client["_localOpsBatchState"].keys()].map((docId) =>
          client["_flushLocalOperations"](docId, { sync: false }),
        ),
      );
      for (const [docId, cacheEntry] of client["_docsCache"]) {
        if (cacheEntry.ownership.role === "owner") {
          void handleSync(client, docId);
        } else {
          void handleSubscribe(client["_socket"], { docId });
        }
      }
    })();
  });
}
