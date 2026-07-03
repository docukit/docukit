import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";
import { broadcastCollaborationState } from "../utils/broadcastCollaborationState.js";

export function handleDisconnect<
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
  socket.on("disconnect", (reason) => {
    const { userId, deviceId, clientId } = socket.data;
    const socketToDocsMap = server["_socketToDocsMap"];
    const presenceByDoc = server["_presenceByDoc"];
    const subscribedDocs = socketToDocsMap.get(socket.id);

    if (subscribedDocs) {
      for (const docId of subscribedDocs) {
        applyPresenceUpdate(presenceByDoc, socket, { docId, presence: null });
        broadcastCollaborationState(server, docId);
        server["_emit"](server["_docUnsubscribeEventListeners"], {
          userId,
          deviceId,
          clientId,
          docId,
          reason,
        });
      }

      socketToDocsMap.delete(socket.id);
    }

    server["_emit"](server["_clientDisconnectEventListeners"], {
      userId,
      deviceId,
      clientId,
      reason,
    });
  });
}
