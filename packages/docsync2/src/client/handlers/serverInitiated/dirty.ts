import type { DocSyncClient } from "../../index.js";
import { invalidateActiveGetDocQueries } from "../../utils/setupQueryClient/invalidateActiveGetDocQueries.js";

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
    invalidateActiveGetDocQueries(client, (args) => args.id === docId);
  });
};
