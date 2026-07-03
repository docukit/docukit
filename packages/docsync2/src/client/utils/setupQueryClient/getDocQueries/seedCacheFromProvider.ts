import { isExistingGetDocData } from "../../../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../../../index.js";
import type { GetDocArgs } from "../../../queries/getDoc/getDoc.js";
import { getDocKey } from "../../../queries/getDoc/getDocKey.js";

export const seedCacheFromProvider = async <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  args: GetDocArgs,
) => {
  const { provider } = await docSync["_localPromise"];
  const docBinding = docSync["_docBinding"];
  const queryClient = docSync["_queryClient"];

  const loaded = await provider.transaction(
    args.createIfMissing ? "readwrite" : "readonly",
    async (ctx) => {
      const stored = await ctx.getSerializedDoc({ docId: args.id });
      if (!stored) {
        if (!args.createIfMissing) return { docId: args.id };

        const created = docBinding.create(args.type, args.id);
        await ctx.saveSerializedDoc({
          docId: created.docId,
          serializedDoc: docBinding.serialize(created.doc),
          clock: 0,
        });
        return created;
      }

      const doc = docBinding.deserialize(stored.serializedDoc);
      const operationsBatches = await ctx.getOperations({ docId: args.id });
      for (const operations of operationsBatches) {
        for (const operation of operations) {
          docBinding.applyOperations(doc, operation);
        }
      }
      return { docId: args.id, doc };
    },
  );

  const queryKey = getDocKey(args);
  const currentData = queryClient.getQueryData(queryKey);
  if (isExistingGetDocData(currentData, docBinding)) return;

  // IndexedDB lets the UI paint fast, but it does not prove remote freshness.
  // https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientsetquerydata
  queryClient.setQueryData(queryKey, loaded, { updatedAt: 0 });
};
