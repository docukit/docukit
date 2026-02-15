/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { ServerConnectionSocket } from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";

type DisconnectDeps = {
  server: DocSyncServer;
  socket: ServerConnectionSocket<{}, {}>;
  userId: string;
  deviceId: string;
  clientId: string;
};

export function handleDisconnect({
  server,
  socket,
  userId,
  deviceId,
  clientId,
}: DisconnectDeps): void {
  socket.on("disconnect", (reason) => {
    const socketToDocsMap = server["_socketToDocsMap"];
    const presenceByDoc = server["_presenceByDoc"];
    const subscribedDocs = socketToDocsMap.get(socket.id);

    if (subscribedDocs) {
      for (const docId of subscribedDocs) {
        applyPresenceUpdate(presenceByDoc, socket, clientId, {
          docId,
          presence: null,
        });
      }

      socketToDocsMap.delete(socket.id);
    }

    server["_emit"](server["_clientDisconnectHandlers"], {
      userId,
      deviceId,
      socketId: socket.id,
      reason,
    });
  });
}
