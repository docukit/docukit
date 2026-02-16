/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../index.js";

type DirtyDeps<D extends {} = {}, S extends {} = {}, O extends {} = {}> = {
  client: DocSyncClient<D, S, O>;
};

export function handleDirty<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: DirtyDeps<D, S, O>): void {
  client["_socket"].on("dirty", (payload) => {
    client.saveRemote({ docId: payload.docId });
  });
}
