/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  DocBinding,
  SyncRequest,
  SyncResponse,
} from "../../shared/types.js";
import type { BroadcastMessage } from "../utils/BCHelper.js";
import type { ClientProvider, ClientSocket, SyncEvent } from "../types.js";

const requestSync = <S, O>(
  socket: ClientSocket<S, O>,
  payload: SyncRequest<O>,
  timeoutMs: number,
): Promise<SyncResponse<S, O>> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout: sync"));
    }, timeoutMs);
    socket.emit("sync", payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
};

const TIMEOUT_MS = 5000;

export const handleSync = async <D extends {}, S extends {}, O extends {}>({
  socket,
  provider,
  docBinding,
  operationsBatches,
  operations,
  docId,
  clientClock,
  presence,
  pushStatusByDocId,
  emitSync,
  applyServerOperations,
  sendMessage,
  getOwnPresencePatch,
  retryPush,
}: {
  socket: ClientSocket<S, O>;
  provider: ClientProvider<S, O>;
  docBinding: DocBinding<D, S, O>;
  operationsBatches: O[][];
  operations: O[];
  docId: string;
  clientClock: number;
  presence?: unknown;
  pushStatusByDocId: Map<string, "idle" | "pushing" | "pushing-with-pending">;
  emitSync: (event: SyncEvent<O, S>) => void;
  applyServerOperations: (args: {
    docId: string;
    operations: O[];
  }) => Promise<void>;
  sendMessage: (message: BroadcastMessage<O>) => void;
  getOwnPresencePatch: (docId: string) => Record<string, unknown> | undefined;
  retryPush: (docId: string) => void;
}): Promise<void> => {
  const payload: SyncRequest<O> = {
    clock: clientClock,
    docId,
    operations,
    ...(presence !== undefined ? { presence } : {}),
  };
  const req = { docId, operations, clock: clientClock };

  let response: SyncResponse<S, O>;
  try {
    response = await requestSync(socket, payload, TIMEOUT_MS);
  } catch (error) {
    emitSync({
      req,
      error: {
        type: "NetworkError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    pushStatusByDocId.set(docId, "idle");
    retryPush(docId);
    return;
  }

  if ("error" in response && response.error) {
    emitSync({ req, error: response.error });
    pushStatusByDocId.set(docId, "idle");
    retryPush(docId);
    return;
  }

  const { data } = response;
  emitSync({
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
    await applyServerOperations({
      docId,
      operations: persistedServerOperations,
    });

    const presencePatch = getOwnPresencePatch(docId);
    for (const op of persistedServerOperations) {
      sendMessage({
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
    retryPush(docId);
  } else {
    pushStatusByDocId.set(docId, "idle");
  }
};
