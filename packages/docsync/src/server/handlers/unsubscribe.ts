import type {
  UnsubscribeDocRequest,
  UnsubscribeDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";
import { broadcastCollaborationState } from "../utils/broadcastCollaborationState.js";

export type UnsubscribeDocHandler = (
  payload: UnsubscribeDocRequest,
  cb: (res: UnsubscribeDocResponse) => void,
) => void | Promise<void>;

export function handleUnsubscribeDoc<
  TContext = unknown,
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
  clientId,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  clientId: string;
}): void {
  const socketToDocsMap = server["_socketToDocsMap"];
  const presenceByDoc = server["_presenceByDoc"];

  socket.on(
    "unsubscribe-doc",
    async (
      { docId }: UnsubscribeDocRequest,
      cb: (res: UnsubscribeDocResponse) => void,
    ): Promise<void> => {
      await socket.leave(`doc:${docId}`);

      const subscribedDocs = socketToDocsMap.get(socket.id);
      if (subscribedDocs) {
        subscribedDocs.delete(docId);
        if (subscribedDocs.size === 0) {
          socketToDocsMap.delete(socket.id);
        }
      }

      applyPresenceUpdate(presenceByDoc, socket, clientId, {
        docId,
        presence: null,
      });
      broadcastCollaborationState(server, docId);

      cb({ success: true });
    },
  );
}
