import type { DocSyncClient } from "../../index.js";
import { receivePushedBatch } from "../../utils/docStream.js";

export function handleOperations<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("operations", (docId, operations) => {
    receivePushedBatch(client, { docId, operations });
  });
}
