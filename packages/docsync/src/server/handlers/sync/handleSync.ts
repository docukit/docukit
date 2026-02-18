/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest, SyncResponse } from "../../../shared/types.js";
import type { ServerConnectionSocket } from "../../types.js";
import type { DocSyncServer } from "../../index.js";
import { applyPresenceUpdate } from "../../utils/applyPresenceUpdate.js";
import { authorize } from "./authorize.js";
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
>({
  server,
  socket,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<S, O, TContext>;
}): void {
  socket.on(
    "sync",
    async (
      payload: SyncRequest<O>,
      cb: (res: SyncResponse<S, O>) => void,
    ): Promise<void> => {
      const { docId } = payload;
      const operations = Array.isArray(payload.operations)
        ? payload.operations
        : [];
      const startTime = Date.now();
      const { userId, deviceId } = socket.data;

      const authorized = await authorize(
        server,
        socket,
        { payload, startTime },
        cb,
      );
      if (!authorized) return;

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

        server["_emit"](server["_syncRequestEventListeners"], {
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
}
