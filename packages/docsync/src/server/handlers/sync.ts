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
        const result = await provider.transaction(
          { mode: "readwrite", docId },
          async (ctx) => {
            const serverDoc = await ctx.getSerializedDoc({ docId });

            // The client already synced this doc (clock > 0), but the server
            // has nothing for it, for example because it expired. Ask for the
            // client's copy instead of saving operations with no doc under them.
            // A log without a snapshot is still the doc, so it is kept as is.
            if (
              serverDoc === undefined &&
              serializedDoc === null &&
              clock > 0 &&
              (await ctx.getOperations({ docId, clock: 0 })).length === 0
            ) {
              return {
                docId,
                operations: [],
                serializedDoc: null,
                clock,
                needsSerializedDoc: true,
              };
            }

            if (serverDoc === undefined && serializedDoc !== null) {
              await ctx.saveSerializedDoc({ docId, serializedDoc, clock });
            }

            // Clients send their doc while they are at clock 0, so a request at
            // clock 0 without one comes from a client with no local copy. Any
            // other client only needs the doc when it is behind the snapshot.
            const clientHasDoc = serializedDoc !== null || clock > 0;
            let responseSerializedDoc: S | null = null;
            let operationsClock = clock;
            if (
              serverDoc !== undefined &&
              (!clientHasDoc || serverDoc.clock > clock)
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
              needsSerializedDoc: false,
            };
          },
        );

        cb({
          data: {
            docId: result.docId,
            operations: result.operations,
            serializedDoc: result.serializedDoc,
            clock: result.clock,
            ...(result.needsSerializedDoc && { needsSerializedDoc: true }),
          },
        });

        const docRoom = io.sockets.adapter.rooms.get(`doc:${docId}`);
        const devicesInRoom = new Set<string>();
        const shouldNotifyClients =
          operations.length > 0 && !result.needsSerializedDoc;

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
          await provider.transaction(
            { mode: "readwrite", docId },
            async (ctx) => {
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
            },
          );
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
