import {
  type ExistingGetDocData,
  isExistingGetDocData,
  isGetDocData,
} from "../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../index.js";
import { getDocKey } from "../queries/getDoc/getDocKey.js";

export type CreateDocArgs = { type: string; id: string };

const loadOrCreateDoc = async <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  args: CreateDocArgs,
) => {
  const { queryClient, docBinding } = docSync["_config"];

  const existingData = queryClient.getQueryData(getDocKey(args));
  if (isExistingGetDocData(existingData, docBinding)) return existingData;
  if (existingData !== undefined && !isGetDocData(existingData))
    throw new Error("Invalid getDoc query data");

  const { provider } = await docSync["_localPromise"];
  const loaded = await provider.transaction("readwrite", async (ctx) => {
    const stored = await ctx.getSerializedDoc({ docId: args.id });
    if (stored) {
      const doc = docBinding.deserialize(stored.serializedDoc);
      const operationsBatches = await ctx.getOperations({ docId: args.id });
      for (const operations of operationsBatches) {
        for (const operation of operations) {
          docBinding.applyOperations(doc, operation);
        }
      }
      return { docId: args.id, doc };
    }

    const { doc, docId } = docBinding.create(args.type, args.id);
    await ctx.saveSerializedDoc({
      docId,
      serializedDoc: docBinding.serialize(doc),
      clock: 0,
    });
    return { docId, doc };
  });

  const currentData = queryClient.getQueryData(getDocKey(args));
  if (isExistingGetDocData(currentData, docBinding)) return currentData;

  queryClient.setQueryData(getDocKey(args), loaded);
  return loaded;
};

export const createDoc = <D extends object, S extends object, O extends object>(
  docSync: DocSyncClient<D, S, O>,
  args: CreateDocArgs,
): Promise<{ docId: string }> => {
  const { queryClient } = docSync["_config"];
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: ["docsync", "createDoc", args.type, args.id],
    // createDoc is a write. It seeds getDoc, but callers should read the doc
    // through getDoc so TanStack Query remains the single source of truth.
    networkMode: "always",
    mutationFn: async () => {
      const data: ExistingGetDocData<D> = await loadOrCreateDoc(docSync, args);
      return { docId: data.docId };
    },
    scope: { id: `docsync:doc:${args.id}` },
  });

  return mutation.execute(undefined);
};
