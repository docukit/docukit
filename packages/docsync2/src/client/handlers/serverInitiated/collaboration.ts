import type { DocSyncClient } from "../../index.js";
import { flushLocalOperations } from "../../utils/flushLocalOperations.js";

export const handleCollaboration = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
}: {
  client: DocSyncClient<D, S, O>;
}) => {
  client["_socket"].on("collaboration", ({ docId, hasCollaborators }) => {
    if (hasCollaborators) {
      client["_collabDocIds"].add(docId);
      void flushLocalOperations(client, docId);
      return;
    }

    client["_collabDocIds"].delete(docId);
  });
};
