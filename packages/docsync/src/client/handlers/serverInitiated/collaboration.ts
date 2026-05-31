/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../index.js";
import { emitCurrentServerPresence } from "../clientInitiated/presence.js";

export function handleCollaboration<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("collaboration", ({ docId, hasCollaborators }) => {
    if (hasCollaborators) {
      client["_collabDocIds"].add(docId);
      emitCurrentServerPresence(client, docId);
      void client["_flushLocalOperations"](docId);
    } else {
      client["_collabDocIds"].delete(docId);
    }
  });
}
