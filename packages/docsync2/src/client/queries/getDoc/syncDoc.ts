/*
 * getDoc is a TanStack Query because it produces the observable document data
 * and represents the remote freshness of that document.
 *
 * Fetching that data has internal side effects because DocSync reconciliation is
 * push/pull. A sync pass can send pending local operations to the server,
 * receive remote operations, write the merged state back to IndexedDB, and
 * apply remote operations to the live in-memory doc.
 *
 * This is still not a public TanStack mutation. The user is not triggering a
 * separate "sync" action; they are observing or refreshing one document by
 * queryKey. Keeping this work inside the getDoc lifecycle means fetchStatus,
 * dataUpdatedAt, isStale, and paused all belong to the same query result.
 *
 * We also avoid an internal mutation for now. A mutation inside a query would
 * create two TanStack lifecycles for one logical fetch and make errors, paused
 * state, and observable UI state harder to reason about. If an integration test
 * proves that TanStack Query dedupe is not strong enough for per-doc sync, we
 * can evaluate an explicit queue or an internal mutation then.
 */
import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../../index.js";
import { requestSync } from "../../utils/request.js";
import { getDocKey, type GetDocKeyArgs } from "./getDocKey.js";

class SyncResponseError extends Error {
  constructor(type: string, message: string) {
    super(message);
    this.name = type;
  }
}

export const isSyncResponseError = (error: unknown) => {
  return error instanceof SyncResponseError;
};

type ApplyOperationsToStoredDocArgs<
  S extends object,
  O extends object,
> = GetDocKeyArgs & {
  operations: O[];
  serverOperations: O[];
  serverSerializedDoc?: S;
  clock: number;
  deleteOperationBatchCount: number;
};

const applyOperationsToStoredDoc = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: ApplyOperationsToStoredDocArgs<S, O>,
) => {
  const { docBinding } = client.config;
  const { provider } = await client["_localPromise"];

  return await provider.transaction("readwrite", async (ctx) => {
    const stored = await ctx.getSerializedDoc({ docId: args.id });
    const serializedDoc = args.serverSerializedDoc ?? stored?.serializedDoc;
    if (serializedDoc === undefined) return;

    const doc = docBinding.deserialize(serializedDoc);
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
    return doc;
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
  const data = client.config.queryClient.getQueryData(getDocKey(args));
  if (!isExistingGetDocData(data, client.config.docBinding)) return;
  if (args.serverOperations.length === 0) return data;

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
  return data;
};

export const syncDocWithServer = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: GetDocKeyArgs,
) => {
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
  const req = {
    type: args.type,
    docId: args.id,
    operations,
    serializedDoc: stored?.serializedDoc,
    clock,
  };
  const getAttempt = () =>
    (client.config.queryClient.getQueryState(getDocKey(args))
      ?.fetchFailureCount ?? 0) + 1;

  try {
    const response = await requestSync(client["_socket"], req);
    if (response.error) {
      client["_events"].emit("sync", {
        req,
        attempt: getAttempt(),
        error: response.error,
      });
      throw new SyncResponseError(response.error.type, response.error.message);
    }

    client["_events"].emit("sync", {
      req,
      attempt: getAttempt(),
      data: response.data,
    });

    const serverOperations = response.data.operations ?? [];
    const applyOperationsArgs: ApplyOperationsToStoredDocArgs<S, O> = {
      ...args,
      operations,
      serverOperations,
      clock: response.data.clock,
      deleteOperationBatchCount: operationsBatches.length,
      ...(response.data.serializedDoc !== undefined
        ? { serverSerializedDoc: response.data.serializedDoc }
        : {}),
    };
    const syncedDoc = await applyOperationsToStoredDoc(
      client,
      applyOperationsArgs,
    );
    const cachedData = applyServerOperationsToCachedDoc(client, {
      ...args,
      serverOperations,
    });
    return cachedData ?? { docId: args.id, doc: syncedDoc };
  } catch (error) {
    if (error instanceof SyncResponseError) throw error;

    client["_events"].emit("sync", {
      req,
      attempt: getAttempt(),
      error: {
        type: "NetworkError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
};
