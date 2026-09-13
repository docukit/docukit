import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { broadcastCollaborationState } from "./broadcastCollaborationState.js";

/**
 * Puts a socket in a document's room, so it receives that document's dirty,
 * presence and collaboration events. Joining is idempotent.
 */
export async function subscribeSocketToDoc<
  TContext,
  D extends object,
  S extends object,
  O extends object,
>({
  server,
  socket,
  userId,
  deviceId,
  clientId,
  docId,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  userId: string;
  deviceId: string;
  clientId: string;
  docId: string;
}): Promise<void> {
  const io = server["_io"];
  const room = io.sockets.adapter.rooms.get(`doc:${docId}`);
  if (room?.has(socket.id)) return;
  await socket.join(`doc:${docId}`);

  const socketToDocsMap = server["_socketToDocsMap"];
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

  const presence = server["_presenceByDoc"].get(docId);
  if (presence) socket.emit("presence", { docId, presence });
  broadcastCollaborationState(server, docId);
}
