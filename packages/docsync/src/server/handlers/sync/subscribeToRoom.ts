/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncServer } from "../../index.js";
import type { ServerConnectionSocket } from "../../types.js";

/**
 * Ensures the socket is in the document room: joins if not already in the room,
 * updates socketToDocsMap, and sends current presence for the doc to the socket.
 */
export async function subscribeToRoom<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  server: DocSyncServer<TContext, D, S, O>,
  socket: ServerConnectionSocket<S, O, TContext>,
  docId: string,
): Promise<void> {
  const io = server["_io"];
  const socketToDocsMap = server["_socketToDocsMap"];
  const presenceByDoc = server["_presenceByDoc"];

  const room = io.sockets.adapter.rooms.get(`doc:${docId}`);
  if (!room?.has(socket.id)) {
    await socket.join(`doc:${docId}`);

    if (!socketToDocsMap.has(socket.id)) {
      socketToDocsMap.set(socket.id, new Set());
    }
    socketToDocsMap.get(socket.id)!.add(docId);

    const presence = presenceByDoc.get(docId);
    if (presence) socket.emit("presence", { docId, presence });
  }
}
