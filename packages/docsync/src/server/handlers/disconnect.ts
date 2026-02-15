import type { ServerConnectionSocket } from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";

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
        const presenceForDoc = presenceByDoc.get(docId);

        socket.to(`doc:${docId}`).emit("presence", {
          docId,
          presence: { [clientId]: null },
        });

        if (presenceForDoc?.[clientId] !== undefined) {
          delete presenceForDoc[clientId];
          if (Object.keys(presenceForDoc).length === 0) {
            presenceByDoc.delete(docId);
          }
        }
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
