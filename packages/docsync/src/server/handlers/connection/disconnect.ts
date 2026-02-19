import type { ServerConnectionSocket } from "../../types.js";
import type { DocSyncServer } from "../../index.js";
import { applyPresenceUpdate } from "../../utils/applyPresenceUpdate.js";

export function handleDisconnect<
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
  socket.on("disconnect", (reason) => {
    const { userId, deviceId } = socket.data;
    const socketToDocsMap = server["_socketToDocsMap"];
    const presenceByDoc = server["_presenceByDoc"];
    const subscribedDocs = socketToDocsMap.get(socket.id);

    if (subscribedDocs) {
      for (const docId of subscribedDocs) {
        applyPresenceUpdate(presenceByDoc, socket, { docId, presence: null });
      }

      socketToDocsMap.delete(socket.id);
    }

    server["_events"].emit("clientDisconnect", {
      userId,
      deviceId,
      socketId: socket.id,
      reason,
    });
  });
}
