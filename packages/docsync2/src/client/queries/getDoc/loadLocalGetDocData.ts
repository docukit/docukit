import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../../index.js";
import type { GetDocArgs } from "./getDoc.js";
import { getDocKey } from "./getDocKey.js";

export const loadLocalGetDocData = async <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  args: GetDocArgs,
) => {
  const { provider } = await docSync["_localPromise"];
  const doc = await provider.transaction("readonly", async (ctx) => {
    const stored = await ctx.getSerializedDoc({ docId: args.id });
    if (!stored) return undefined;

    const doc = docSync.config.docBinding.deserialize(stored.serializedDoc);
    const operationsBatches = await ctx.getOperations({ docId: args.id });
    for (const operations of operationsBatches) {
      for (const operation of operations) {
        docSync.config.docBinding.applyOperations(doc, operation);
      }
    }
    return doc;
  });

  return { docId: args.id, doc };
};

export const seedLocalGetDocData = async <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  args: GetDocArgs,
) => {
  const queryKey = getDocKey(args);
  const localData = await loadLocalGetDocData(docSync, args);
  const currentData = docSync.config.queryClient.getQueryData(queryKey);

  if (isExistingGetDocData(currentData, docSync.config.docBinding)) return;

  // IndexedDB lets the UI paint fast, but it does not prove remote freshness.
  // https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientsetquerydata
  docSync.config.queryClient.setQueryData(queryKey, localData, {
    updatedAt: 0,
  });
};
