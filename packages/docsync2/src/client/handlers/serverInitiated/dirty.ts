import type { DocSyncClient } from "../../index.js";
import { invalidateDoc } from "../../utils/invalidateDoc.js";

export const handleDirty = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
}: {
  client: DocSyncClient<D, S, O>;
}) => {
  client["_socket"].on("dirty", ({ docId }) => {
    void invalidateDoc(client, docId);
  });
};
