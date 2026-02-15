/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  BroadcastMessage,
  ClientSocket,
  DocBinding,
  Provider,
  SyncEvent,
} from "../../shared/types.js";
import type {
  SyncOperationsRequest,
  SyncOperationsResponse,
} from "../../server/handlers/sync.js";

type SyncRequestContext<O> = {
  docId: string;
  operations: O[];
  clock: number;
};

type HandleSyncResultArgs<S, O> = {
  socket: ClientSocket<S, O>;
  payload: SyncOperationsRequest<O>;
  req: SyncRequestContext<O>;
  emitSync: (event: SyncEvent<O, S>) => void;
  timeoutMs?: number;
};

export type HandleSyncResult<S, O> =
  | { kind: "retry" }
  | {
      kind: "success";
      data: {
        docId: string;
        operations?: O[];
        serializedDoc?: S;
        clock: number;
      };
    };

const requestSyncOperations = <S, O>(
  socket: ClientSocket<S, O>,
  payload: SyncOperationsRequest<O>,
  timeoutMs: number,
): Promise<SyncOperationsResponse<S, O>> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout: sync-operations"));
    }, timeoutMs);
    socket.emit("sync-operations", payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
};

export const handleSync = async <S, O>({
  socket,
  payload,
  req,
  emitSync,
  timeoutMs = 5000,
}: HandleSyncResultArgs<S, O>): Promise<HandleSyncResult<S, O>> => {
  let response: SyncOperationsResponse<S, O>;
  try {
    response = await requestSyncOperations(socket, payload, timeoutMs);
  } catch (error) {
    emitSync({
      req,
      error: {
        type: "NetworkError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return { kind: "retry" };
  }

  if ("error" in response && response.error) {
    emitSync({
      req,
      error: response.error,
    });
    return { kind: "retry" };
  }

  const { data } = response;
  emitSync({
    req,
    data: {
      ...(data.operations ? { operations: data.operations } : {}),
      ...(data.serializedDoc ? { serializedDoc: data.serializedDoc } : {}),
      clock: data.clock,
    },
  });

  return { kind: "success", data };
};

type PushStatus = "idle" | "pushing" | "pushing-with-pending";

type HandleSyncAndDoPushArgs<D extends {}, S extends {}, O extends {}> = {
  socket: ClientSocket<S, O>;
  provider: Provider<S, O, "client">;
  docBinding: DocBinding<D, S, O>;
  operationsBatches: O[][];
  operations: O[];
  docId: string;
  clientClock: number;
  presence?: unknown;
  pushStatusByDocId: Map<string, PushStatus>;
  emitSync: (event: SyncEvent<O, S>) => void;
  applyServerOperations: (args: {
    docId: string;
    operations: O[];
  }) => Promise<void>;
  sendMessage: (message: BroadcastMessage<O>) => void;
  getOwnPresencePatch: (docId: string) => Record<string, unknown> | undefined;
  retryPush: (docId: string) => void;
};

export const handleSyncAndDoPush = async <
  D extends {},
  S extends {},
  O extends {},
>({
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
}: HandleSyncAndDoPushArgs<D, S, O>): Promise<void> => {
  const syncResult = await handleSync<S, O>({
    socket,
    payload: {
      clock: clientClock,
      docId,
      operations,
      ...(presence !== undefined ? { presence } : {}),
    },
    req: {
      docId,
      operations,
      clock: clientClock,
    },
    emitSync,
  });

  if (syncResult.kind === "retry") {
    pushStatusByDocId.set(docId, "idle");
    retryPush(docId);
    return;
  }

  const { data } = syncResult;
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
