import type { DocSyncServer } from "../../index.js";
import type { ServerConnectionSocket } from "../../types.js";

export type NotifyClientsResult = {
  clientsCount: number;
  devicesCount: number;
};

/**
 * Notifies other clients in the document room that the doc is dirty (when the
 * requester sent operations). Returns client and device counts for the sync event.
 */
export function notifyClients<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  server: DocSyncServer<TContext, D, S, O>,
  socket: ServerConnectionSocket<S, O, TContext>,
  docId: string,
  operations: O[] | "deleted",
): NotifyClientsResult {
  const io = server["_io"];
  const deviceId = socket.data.deviceId;
  const docRoom = io.sockets.adapter.rooms.get(`doc:${docId}`);
  const devicesInRoom = new Set<string>();
  const shouldNotifyClients = operations === "deleted" || operations.length > 0;

  if (docRoom) {
    for (const socketId of docRoom) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) continue;

      const targetDeviceId = targetSocket.data.deviceId;
      devicesInRoom.add(targetDeviceId);

      if (shouldNotifyClients) {
        if (targetSocket.id !== socket.id && targetDeviceId !== deviceId) {
          targetSocket.emit("dirty", { docId });
        }
      }
    }
  }

  return { clientsCount: docRoom?.size ?? 0, devicesCount: devicesInRoom.size };
}
