import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../../index.js";
import {
  getDocKey,
  type GetDocKeyArgs,
} from "../../queries/getDoc/getDocKey.js";
import { requestSync } from "../../utils/request.js";

const applyOperationsToStoredDoc = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: GetDocKeyArgs & {
    operations: O[];
    serverOperations: O[];
    clock: number;
    deleteOperationBatchCount: number;
  },
) => {
  const { docBinding } = client.config;
  const { provider } = await client["_localPromise"];

  await provider.transaction("readwrite", async (ctx) => {
    const stored = await ctx.getSerializedDoc({ docId: args.id });
    if (!stored) return;

    const doc = docBinding.deserialize(stored.serializedDoc);
    for (const operation of [...args.serverOperations, ...args.operations]) {
      docBinding.applyOperations(doc, operation);
    }

    await ctx.saveSerializedDoc({
      docId: args.id,
      serializedDoc: docBinding.serialize(doc),
      clock: args.clock,
    });
    if (args.deleteOperationBatchCount > 0) {
      await ctx.deleteOperations({
        docId: args.id,
        count: args.deleteOperationBatchCount,
      });
    }
  });
};

const applyServerOperationsToCachedDoc = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: GetDocKeyArgs & { serverOperations: O[] },
) => {
  if (args.serverOperations.length === 0) return;

  const data = client.config.queryClient.getQueryData(getDocKey(args));
  if (!isExistingGetDocData(data, client.config.docBinding)) return;

  client["_changeOrigin"] = "network";
  try {
    for (const operation of args.serverOperations) {
      client.config.docBinding.applyOperations(data.doc, operation, {
        skipUndo: true,
      });
    }
  } finally {
    client["_changeOrigin"] = "local";
  }
};

const runSync = async <D extends object, S extends object, O extends object>(
  client: DocSyncClient<D, S, O>,
  args: GetDocKeyArgs,
) => {
  if (!client["_socket"].connected) return;

  const { provider } = await client["_localPromise"];
  const [operationsBatches, stored] = await provider.transaction(
    "readonly",
    (ctx) =>
      Promise.all([
        ctx.getOperations({ docId: args.id }),
        ctx.getSerializedDoc({ docId: args.id }),
      ]),
  );
  const operations = operationsBatches.flat();
  const clock = stored?.clock ?? 0;
  const req = { type: args.type, docId: args.id, operations, clock };

  try {
    const response = await requestSync(client["_socket"], req);
    client["_events"].emit("sync", { req, ...response });
    if (response.error) return;

    const serverOperations = response.data.operations ?? [];
    await applyOperationsToStoredDoc(client, {
      ...args,
      operations,
      serverOperations,
      clock: response.data.clock,
      deleteOperationBatchCount: operationsBatches.length,
    });
    applyServerOperationsToCachedDoc(client, { ...args, serverOperations });
  } catch (error) {
    client["_events"].emit("sync", {
      req,
      error: {
        type: "NetworkError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
};

export const handleSync = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: GetDocKeyArgs,
): Promise<void> => {
  // Mutations with the same scope id run in a serial queue, so syncs for one doc never overlap.
  // https://tanstack.com/query/latest/docs/framework/react/guides/mutations#mutation-scopes
  const mutation = client.config.queryClient
    .getMutationCache()
    .build(client.config.queryClient, {
      mutationKey: ["docsync", "sync", args.type, args.id],
      scope: { id: `docsync:sync:${args.id}` },
      retry: 0,
      mutationFn: () => runSync(client, args),
    });

  await mutation.execute(undefined);
};
