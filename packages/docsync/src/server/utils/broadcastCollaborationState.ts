/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncServer } from "../index.js";

export function broadcastCollaborationState<
  TContext,
  D extends {},
  S extends {},
  O extends {},
>(server: DocSyncServer<TContext, D, S, O>, docId: string): void {
  const io = server["_io"];
  const room = io.sockets.adapter.rooms.get(`doc:${docId}`);
  if (!room) return;

  const socketIds: string[] = [];
  const userIds = new Set<string>();
  for (const socketId of room) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket) continue;
    const { userId } = targetSocket.data as { userId: string };
    socketIds.push(socketId);
    userIds.add(userId);
  }

  const hasCollaborators = userIds.size > 1;
  for (const socketId of socketIds) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket) continue;
    targetSocket.emit("collaboration", { docId, hasCollaborators });
  }
}
