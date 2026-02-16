/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest, SyncResponse } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";

const OPERATION_THRESHOLD = 100;

export type { SyncRequest, SyncResponse } from "../../shared/types.js";

export type SyncHandler<S = unknown, O = unknown> = (
  payload: SyncRequest<O>,
  cb: (res: SyncResponse<S, O>) => void,
) => void | Promise<void>;

type SyncDeps<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> = {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<S, O>;
  userId: string;
  deviceId: string;
  clientId: string;
  context: TContext;
};

export function handleSync<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({
  server,
  socket,
  userId,
  deviceId,
  clientId,
  context,
}: SyncDeps<TContext, D, S, O>): void {
  const authorize = server["_authorize"];
  const authorizeSync = async (payload: SyncRequest<O>): Promise<boolean> => {
    if (!authorize) return true;
    return authorize({
      type: "sync",
      payload,
      userId,
      context,
    });
  };

  const handler: SyncHandler<S, O> = async (
    payload: SyncRequest<O>,
    cb: (res: SyncResponse<S, O>) => void,
  ): Promise<void> => {
    const { docId, operations = [], clock } = payload;
    const startTime = Date.now();

    const authorized = await authorizeSync(payload);
    if (!authorized) {
      const errorEvent = {
        type: "AuthorizationError" as const,
        message: "Access denied",
      };

      server["_emit"](server["_syncRequestEventListeners"], {
        userId,
        deviceId,
        socketId: socket.id,
        status: "error",
        req: payload,
        error: errorEvent,
        durationMs: Date.now() - startTime,
      });

      cb({
        error: errorEvent,
      });
      return;
    }

    const io = server["_io"];
    const provider = server["_provider"];
    const docBinding = server["_docBinding"];
    const socketToDocsMap = server["_socketToDocsMap"];
    const presenceByDoc = server["_presenceByDoc"];

    const room = io.sockets.adapter.rooms.get(`doc:${docId}`);
    if (!room?.has(socket.id)) {
      await socket.join(`doc:${docId}`);

      if (!socketToDocsMap.has(socket.id)) {
        socketToDocsMap.set(socket.id, new Set());
      }
      socketToDocsMap.get(socket.id)!.add(docId);

      const presence = presenceByDoc.get(docId);
      if (presence) socket.emit("presence", { docId, presence });
    }

    if ("presence" in payload) {
      applyPresenceUpdate(server["_presenceByDoc"], socket, clientId, {
        docId,
        presence: payload.presence,
      });
    }

    try {
      const result = await provider.transaction("readwrite", async (ctx) => {
        const serverOps = await ctx.getOperations({ docId, clock });
        const serverDoc = await ctx.getSerializedDoc(docId);
        const newClock = await ctx.saveOperations({
          docId,
          operations,
        });

        return {
          docId,
          ...(serverOps.length > 0 ? { operations: serverOps.flat() } : {}),
          ...(serverDoc?.serializedDoc
            ? { serializedDoc: serverDoc.serializedDoc }
            : {}),
          clock: newClock,
        };
      });

      cb({
        data: {
          docId: result.docId,
          ...(result.operations ? { operations: result.operations } : {}),
          ...(result.serializedDoc
            ? { serializedDoc: result.serializedDoc }
            : {}),
          clock: result.clock,
        },
      });

      const docRoom = io.sockets.adapter.rooms.get(`doc:${payload.docId}`);
      const devicesInRoom = new Set<string>();
      const shouldNotifyClients =
        payload.operations && payload.operations.length > 0;

      if (docRoom) {
        for (const socketId of docRoom) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (!targetSocket) continue;

          const targetDeviceId = (targetSocket.data as { deviceId: string })
            .deviceId;
          devicesInRoom.add(targetDeviceId);

          if (shouldNotifyClients) {
            if (targetSocket.id !== socket.id && targetDeviceId !== deviceId) {
              targetSocket.emit("dirty", { docId: payload.docId });
            }
          }
        }
      }

      server["_emit"](server["_syncRequestEventListeners"], {
        userId,
        deviceId,
        socketId: socket.id,
        status: "success",
        req: {
          docId: payload.docId,
          operations,
          clock: payload.clock,
        },
        ...(result.operations || result.serializedDoc
          ? {
              res: {
                ...(result.operations ? { operations: result.operations } : {}),
                ...(result.serializedDoc
                  ? { serializedDoc: result.serializedDoc }
                  : {}),
                clock: result.clock,
              },
            }
          : {}),
        durationMs: Date.now() - startTime,
        clientsCount: docRoom?.size ?? 0,
        devicesCount: devicesInRoom.size,
      });

      if (
        result.operations &&
        result.operations.length >= OPERATION_THRESHOLD
      ) {
        const {
          docId: resultDocId,
          operations: serverOps,
          serializedDoc,
          clock: resultClock,
        } = result;
        const allOperations = [...serverOps, ...(payload.operations ?? [])];
        const doc = serializedDoc
          ? docBinding.deserialize(serializedDoc)
          : docBinding.create("test", resultDocId).doc;
        allOperations.forEach((operation) => {
          docBinding.applyOperations(doc, operation);
        });
        const newSerializedDoc = docBinding.serialize(doc);
        await provider.transaction("readwrite", async (ctx) => {
          await ctx.saveSerializedDoc({
            docId: resultDocId,
            serializedDoc: newSerializedDoc,
            clock: resultClock,
          });
          await ctx.deleteOperations({ docId: resultDocId, count: 1 });
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const errorEvent = {
        type: "DatabaseError" as const,
        message: errorMessage,
      };

      server["_emit"](server["_syncRequestEventListeners"], {
        userId,
        deviceId,
        socketId: socket.id,
        status: "error",
        req: {
          docId: payload.docId,
          operations,
          clock: payload.clock,
        },
        error: {
          ...errorEvent,
          ...(error instanceof Error && error.stack
            ? { stack: error.stack }
            : {}),
        },
        durationMs: Date.now() - startTime,
      });

      cb({
        error: errorEvent,
      });
    }
  };

  socket.on("sync", handler);
}
