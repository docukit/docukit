import type { SyncResponse } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { createSyncValidation } from "./sync/validation.js";
import { broadcastCollaborationState } from "../utils/broadcastCollaborationState.js";

export type SyncHandler<S = unknown, O = unknown> = (
  payload: unknown,
  cb: (res: SyncResponse<S, O>) => void,
) => void | Promise<void>;

export function handleSync<
  TContext extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
}: {
  server: DocSyncServer<TContext, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
}): void {
  socket.on(
    "sync",
    async (
      req: unknown,
      cb: (res: SyncResponse<S, O>) => void,
    ): Promise<void> => {
      const startTime = Date.now();
      const validation = createSyncValidation({
        server,
        socket,
        req,
        cb,
        startTime,
      });

      const envelope = validation.envelope();
      if (!envelope) return;

      const { docId, clock } = envelope;
      const { userId, deviceId, context } = socket.data;

      const authorized = server["_authorize"]
        ? await server["_authorize"]({
            type: "sync",
            req: envelope,
            userId,
            context,
          })
        : true;
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
          req: envelope,
          error: errorEvent,
          durationMs: Date.now() - startTime,
        });

        cb({ error: errorEvent });
        return;
      }

      const io = server["_io"];
      const provider = server["_provider"];
      const socketToDocsMap = server["_socketToDocsMap"];
      const presenceByDoc = server["_presenceByDoc"];

      const operations = validation.operations(envelope);
      if (!operations) return;
      const serializedDoc = validation.serializedDoc(envelope);
      if (envelope.serializedDoc !== undefined && serializedDoc === undefined)
        return;

      const room = io.sockets.adapter.rooms.get(`doc:${docId}`);
      if (!room?.has(socket.id)) {
        await socket.join(`doc:${docId}`);

        if (!socketToDocsMap.has(socket.id)) {
          socketToDocsMap.set(socket.id, new Set());
        }
        socketToDocsMap.get(socket.id)!.add(docId);

        const presence = presenceByDoc.get(docId);
        if (presence) socket.emit("presence", { docId, presence });
        broadcastCollaborationState(server, docId);
      }

      try {
        const stored = await provider.transaction("readwrite", async (ctx) => {
          const serverOps = await ctx.getOperations({ docId, clock });
          const serverDoc = await ctx.getSerializedDoc({ docId });

          // Doc snapshots are accepted after authorization. Apps that need
          // stricter edit rules should enforce them in authorize().
          if (
            serializedDoc !== undefined &&
            (serverDoc === undefined || serverDoc.clock < clock)
          ) {
            await ctx.saveSerializedDoc({ docId, serializedDoc, clock });
            await ctx.deleteOperationsUntil({ docId, clock });
          }

          const responseSerializedDoc =
            serverDoc !== undefined &&
            (serializedDoc === undefined || serverDoc.clock > clock)
              ? serverDoc.serializedDoc
              : undefined;
          const validatedStored = validation.stored({
            docId,
            operations: serverOps.flat(),
            serializedDoc: responseSerializedDoc,
            clock: serverDoc?.clock ?? clock,
          });
          if (!validatedStored) return;

          const newClock = await ctx.saveOperations({ docId, operations });

          return { ...validatedStored, clock: newClock };
        });
        if (!stored) return;

        cb({
          data: {
            docId: stored.docId,
            ...(stored.operations ? { operations: stored.operations } : {}),
            ...(stored.serializedDoc
              ? { serializedDoc: stored.serializedDoc }
              : {}),
            clock: stored.clock,
          },
        });

        const docRoom = io.sockets.adapter.rooms.get(`doc:${docId}`);
        const devicesInRoom = new Set<string>();
        const shouldNotifyClients = operations.length > 0;

        if (docRoom) {
          for (const socketId of docRoom) {
            const targetSocket = io.sockets.sockets.get(socketId);
            if (!targetSocket) continue;

            const { deviceId: targetDeviceId } = targetSocket.data;
            devicesInRoom.add(targetDeviceId);

            if (shouldNotifyClients) {
              if (
                targetSocket.id !== socket.id &&
                targetDeviceId !== deviceId
              ) {
                targetSocket.emit("dirty", { docId });
              }
            }
          }
        }

        server["_emit"](server["_syncRequestEventListeners"], {
          userId,
          deviceId,
          socketId: socket.id,
          status: "success",
          req: envelope,
          ...(stored.operations || stored.serializedDoc
            ? {
                res: {
                  ...(stored.operations
                    ? { operations: stored.operations }
                    : {}),
                  ...(stored.serializedDoc
                    ? { serializedDoc: stored.serializedDoc }
                    : {}),
                  clock: stored.clock,
                },
              }
            : {}),
          durationMs: Date.now() - startTime,
          clientsCount: docRoom?.size ?? 0,
          devicesCount: devicesInRoom.size,
        });
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
          req: envelope,
          error: {
            ...errorEvent,
            ...(error instanceof Error && error.stack
              ? { stack: error.stack }
              : {}),
          },
          durationMs: Date.now() - startTime,
        });

        cb({ error: errorEvent });
      }
    },
  );
}
