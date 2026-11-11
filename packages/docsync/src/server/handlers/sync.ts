import type { SyncRequest, SyncResponse } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { broadcastCollaborationState } from "../utils/broadcastCollaborationState.js";

const OPERATION_THRESHOLD = 100;

export type SyncHandler<S = unknown, O = unknown> = (
  payload: SyncRequest<S, O>,
  cb: (res: SyncResponse<S, O>) => void,
) => void | Promise<void>;

export function handleSync<
  TContext = unknown,
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
  userId,
  deviceId,
  clientId,
  context,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  userId: string;
  deviceId: string;
  clientId: string;
  context: TContext;
}): void {
  socket.on(
    "sync",
    async (
      req: SyncRequest<S, O>,
      cb: (res: SyncResponse<S, O>) => void,
    ): Promise<void> => {
      const { docId, operations, serializedDoc, clock } = req;
      const startTime = Date.now();

      // TODO: we should validate req with Valibot here

      const authorized = server["_authorize"]
        ? await server["_authorize"]({ type: "sync", req, userId, context })
        : true;
      if (!authorized) {
        const errorEvent = {
          type: "AuthorizationError" as const,
          message: "Access denied",
        };

        server["_emit"](server["_syncRequestEventListeners"], {
          userId,
          deviceId,
          clientId,
          status: "error",
          req,
          error: { ...errorEvent, stack: null },
          durationMs: Date.now() - startTime,
        });

        cb({ error: errorEvent });
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

        let subscribedDocs = socketToDocsMap.get(socket.id);
        if (!subscribedDocs) {
          subscribedDocs = new Set();
          socketToDocsMap.set(socket.id, subscribedDocs);
        }
        subscribedDocs.add(docId);

        server["_emit"](server["_docSubscribeEventListeners"], {
          userId,
          deviceId,
          clientId,
          docId,
        });

        const presence = presenceByDoc.get(docId);
        if (presence) socket.emit("presence", { docId, presence });
        broadcastCollaborationState(server, docId);
      }

      try {
        const result = await provider.transaction("readwrite", async (ctx) => {
          const serverDoc = await ctx.getSerializedDoc({ docId });

          if (serverDoc === undefined && serializedDoc !== null) {
            await ctx.saveSerializedDoc({ docId, serializedDoc, clock });
          }

          let responseSerializedDoc: S | null = null;
          let operationsClock = clock;
          if (
            serverDoc !== undefined &&
            (serializedDoc === null || serverDoc.clock > clock)
          ) {
            responseSerializedDoc = serverDoc.serializedDoc;
            operationsClock = serverDoc.clock;
          }

          const serverOps = await ctx.getOperations({
            docId,
            clock: operationsClock,
          });
          const newClock = await ctx.saveOperations({ docId, operations });

          return {
            docId,
            operations: serverOps.flat(),
            serializedDoc: responseSerializedDoc,
            clock: newClock,
          };
        });

        cb({
          data: {
            docId: result.docId,
            operations: result.operations,
            serializedDoc: result.serializedDoc,
            clock: result.clock,
          },
        });

        const docRoom = io.sockets.adapter.rooms.get(`doc:${docId}`);
        const devicesInRoom = new Set<string>();
        const shouldNotifyClients = operations.length > 0;

        if (docRoom) {
          for (const socketId of docRoom) {
            const targetSocket = io.sockets.sockets.get(socketId);
            if (!targetSocket) continue;

            const targetDeviceId = (targetSocket.data as { deviceId: string })
              .deviceId;
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
          clientId,
          status: "success",
          req,
          res: {
            operations: result.operations,
            serializedDoc: result.serializedDoc,
            clock: result.clock,
          },
          durationMs: Date.now() - startTime,
          clientsCount: docRoom?.size ?? 0,
          devicesCount: devicesInRoom.size,
        });

        if (result.operations.length >= OPERATION_THRESHOLD) {
          await provider.transaction("readwrite", async (ctx) => {
            const current = await ctx.getSerializedDoc({ docId });
            // Without a snapshot the log is the only copy of these edits.
            if (current === undefined) return;
            const batches = await ctx.getOperations({
              docId,
              clock: current.clock,
            });
            if (batches.length === 0) return;

            const doc = docBinding.deserialize(current.serializedDoc);
            batches.flat().forEach((operation) => {
              docBinding.applyOperations(doc, operation);
            });
            await ctx.saveSerializedDoc({
              docId,
              serializedDoc: docBinding.serialize(doc),
              // Read here, not taken from the response: a sync that landed in
              // between is part of `batches` and must be covered by the clock.
              clock: await ctx.saveOperations({ docId, operations: [] }),
            });
            await ctx.deleteOperations({ docId, count: batches.length });
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
          clientId,
          status: "error",
          req,
          error: {
            ...errorEvent,
            stack: error instanceof Error ? (error.stack ?? null) : null,
          },
          durationMs: Date.now() - startTime,
        });

        cb({ error: errorEvent });
      }
    },
  );
}
