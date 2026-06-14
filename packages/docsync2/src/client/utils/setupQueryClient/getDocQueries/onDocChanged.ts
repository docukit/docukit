import type { DocSyncClient } from "../../../index.js";
import type { GetDocArgs } from "../../../queries/getDoc/getDoc.js";
import { invalidateDoc } from "../../invalidateDoc.js";

export const onDocChanged = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: GetDocArgs,
  { operations }: { operations: O },
) => {
  const origin = client["_changeOrigin"];
  client["_events"].emit("change", {
    docId: args.id,
    origin,
    operation: operations,
  });

  if (origin !== "local") return;

  void client["_localPromise"].then(({ provider }) =>
    provider
      .transaction("readwrite", (ctx) =>
        ctx.saveOperations({ docId: args.id, operations: [operations] }),
      )
      .then(() => invalidateDoc(client, args.id)),
  );
};
