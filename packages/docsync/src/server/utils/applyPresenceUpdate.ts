/* eslint-disable @typescript-eslint/no-empty-object-type */
import { mergePresencePatch } from "../../shared/presencePatch.js";
import type { Presence } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";

/**
 * Updates server presence state for a document and broadcasts the change
 * to other clients in the doc room. Handlers import and call this directly.
 */
export function applyPresenceUpdate(
  presenceByDoc: Map<string, Presence>,
  socket: ServerConnectionSocket<{}, {}>,
  clientId: string,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;
  const currentPresence = presenceByDoc.get(docId) ?? {};
  const newPresence = mergePresencePatch(currentPresence, {
    [clientId]: presence ?? null,
  });

  if (Object.keys(newPresence).length > 0) {
    presenceByDoc.set(docId, newPresence);
  } else {
    presenceByDoc.delete(docId);
  }

  socket.to(`doc:${docId}`).emit("presence", {
    docId,
    presence: { [clientId]: presence ?? null },
  });
}
