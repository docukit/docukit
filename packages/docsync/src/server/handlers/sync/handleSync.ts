import type { SyncRequest, SyncResponse } from "../../../shared/types.js";
import type { DocSyncServer } from "../../index.js";
import { applyPresenceUpdate } from "../../utils/applyPresenceUpdate.js";
import { handleError } from "./handleError.js";
import { notifyClients } from "./notifyClients.js";
import { runSyncTransaction } from "./runSyncTransaction.js";
import { squashIfNeeded } from "./squashIfNeeded.js";
import { subscribeToRoom } from "./subscribeToRoom.js";

export type SyncHandler<S = unknown, O = unknown> = (
  payload: SyncRequest<O>,
  cb: (res: SyncResponse<S, O>) => void,
) => void | Promise<void>;

export function handleSync<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ server }: { server: DocSyncServer<TContext, D, S, O> }): void {
  // TODO: private _LRUCache = new Map<string, { deviceId: string; clock: number }>();
  const io = server["_io"];

  io.on("connection", (socket) => {
    socket.on(
      "sync",
      async (
        payload: SyncRequest<O>,
        cb: (res: SyncResponse<S, O>) => void,
      ): Promise<void> => {
        const { docId } = payload;
        const operations = payload.operations ?? [];
        const startTime = Date.now();
        const { userId, deviceId } = socket.data;

        // Subscribe to the document room if not already subscribed
        await subscribeToRoom(server, socket, docId);

        if ("presence" in payload) {
          applyPresenceUpdate(server["_presenceByDoc"], socket, {
            docId,
            presence: payload.presence,
          });
        }

        try {
          const provider = server["_provider"];
          const result = await runSyncTransaction(provider, payload);

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

          const { clientsCount, devicesCount } = notifyClients(
            server,
            socket,
            payload.docId,
            operations,
          );

          server["_events"].emit("syncRequest", {
            userId,
            deviceId,
            socketId: socket.id,
            status: "success",
            req: { docId: payload.docId, operations, clock: payload.clock },
            ...(result.operations || result.serializedDoc
              ? {
                  res: {
                    ...(result.operations
                      ? { operations: result.operations }
                      : {}),
                    ...(result.serializedDoc
                      ? { serializedDoc: result.serializedDoc }
                      : {}),
                    clock: result.clock,
                  },
                }
              : {}),
            durationMs: Date.now() - startTime,
            clientsCount,
            devicesCount,
          });

          await squashIfNeeded(server, payload, result);
        } catch (error) {
          handleError(
            server,
            socket,
            { docId: payload.docId, operations, clock: payload.clock },
            error,
            startTime,
            cb,
          );
        }
      },
    );
  });
}
