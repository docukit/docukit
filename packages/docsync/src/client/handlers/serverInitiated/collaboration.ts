import type { DocSyncClient } from "../../index.js";
import { emitCurrentServerPresence } from "../clientInitiated/presence.js";
import { handleSync } from "../clientInitiated/sync/sync.js";

export function handleCollaboration<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("collaboration", ({ docId, hasCollaborators }) => {
    if (hasCollaborators) {
      client["_collabDocIds"].add(docId);
      emitCurrentServerPresence(client, docId);
      const hadPendingSync = client["_syncDebounceState"].has(docId);
      void client["_flushLocalOperations"](docId, { sync: false }).then(
        (didFlush) => {
          if (didFlush || hadPendingSync) void handleSync(client, docId);
        },
      );
    } else {
      client["_collabDocIds"].delete(docId);
    }
  });
}
