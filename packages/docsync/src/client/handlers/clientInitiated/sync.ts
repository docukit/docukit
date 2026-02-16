/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest, SyncResponse } from "../../../shared/types.js";
import type { DocSyncClient } from "../../index.js";
import { request } from "../../utils/request.js";

/** Applies server operations to the cached doc and emits change event (remote). */
export async function applyServerOperations<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const doc = await cacheEntry.promisedDoc;
  if (!doc) return;

  client["_shouldBroadcast"] = false;
  for (const op of args.operations) {
    client["_docBinding"].applyOperations(doc, op);
  }
  client["_shouldBroadcast"] = true;

  client["_emit"](client["_changeEventListeners"], {
    docId: args.docId,
    origin: "remote",
    operations: args.operations,
  });
}

/**
 * Replaces the cached document (e.g. when server responds with a squashed doc).
 * Keeps refCount, presence, and presenceListeners unchanged.
 */
export async function replaceDocInCache<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; doc?: D; serializedDoc?: S },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;
  if (args.doc === undefined && args.serializedDoc === undefined) return;

  const newDoc =
    args.doc ?? client["_docBinding"].deserialize(args.serializedDoc!);

  client["_docsCache"].set(args.docId, {
    promisedDoc: Promise.resolve(newDoc),
    refCount: cacheEntry.refCount,
    presence: cacheEntry.presence,
    presenceListeners: cacheEntry.presenceListeners,
  });
}

export const handleSync = async <D extends {}, S extends {}, O extends {}>({
  client,
  operationsBatches,
  operations,
  docId,
  clientClock,
  presence,
}: {
  client: DocSyncClient<D, S, O>;
  operationsBatches: O[][];
  operations: O[];
  docId: string;
  clientClock: number;
  presence?: unknown;
}): Promise<void> => {
  const { provider } = await client["_localPromise"];
  const socket = client["_socket"];
  const docBinding = client["_docBinding"];
  const pushStatusByDocId = client["_pushStatusByDocId"];

  const payload: SyncRequest<O> = {
    clock: clientClock,
    docId,
    operations,
    ...(presence !== undefined ? { presence } : {}),
  };
  const req = { docId, operations, clock: clientClock };

  let response: SyncResponse<S, O>;
  try {
    response = await request(socket, "sync", payload);
  } catch (error) {
    client["_emit"](client["_syncEventListeners"], {
      req,
      error: {
        type: "NetworkError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    pushStatusByDocId.set(docId, "idle");
    void client["_doPush"]({ docId });
    return;
  }

  if ("error" in response && response.error) {
    client["_emit"](client["_syncEventListeners"], {
      req,
      error: response.error,
    });
    pushStatusByDocId.set(docId, "idle");
    void client["_doPush"]({ docId });
    return;
  }

  const { data } = response;
  client["_emit"](client["_syncEventListeners"], {
    req,
    data: {
      docId: data.docId,
      ...(data.operations ? { operations: data.operations } : {}),
      ...(data.serializedDoc ? { serializedDoc: data.serializedDoc } : {}),
      clock: data.clock,
    },
  });
  let didConsolidate = false;

  await provider.transaction("readwrite", async (ctx) => {
    if (operationsBatches.length > 0) {
      await ctx.deleteOperations({
        docId,
        count: operationsBatches.length,
      });
    }

    const stored = await ctx.getSerializedDoc(docId);
    if (!stored) return;

    if (stored.clock >= data.clock) {
      didConsolidate = false;
      return;
    }

    const serverOps = data.operations ?? [];
    const allOps = [...serverOps, ...operations];
    if (allOps.length === 0) return;

    const doc = docBinding.deserialize(stored.serializedDoc);
    for (const op of allOps) {
      docBinding.applyOperations(doc, op);
    }
    const serializedDoc = docBinding.serialize(doc);

    const recheckStored = await ctx.getSerializedDoc(docId);
    if (recheckStored?.clock !== stored.clock) {
      return;
    }

    await ctx.saveSerializedDoc({
      serializedDoc,
      docId,
      clock: data.clock,
    });
    didConsolidate = true;
  });

  const persistedServerOperations = data.operations ?? [];
  if (didConsolidate && persistedServerOperations.length > 0) {
    await applyServerOperations(client, {
      docId,
      operations: persistedServerOperations,
    });

    const presencePatch = client["_getOwnPresencePatch"](docId);
    for (const op of persistedServerOperations) {
      client["_bcHelper"]?.broadcast({
        type: "OPERATIONS",
        operations: op,
        docId,
        ...(presencePatch && { presence: presencePatch }),
      });
    }
  }

  const currentStatus = pushStatusByDocId.get(docId);
  const shouldRetry = currentStatus === "pushing-with-pending";
  if (shouldRetry) {
    void client["_doPush"]({ docId });
  } else {
    pushStatusByDocId.set(docId, "idle");
  }
};
