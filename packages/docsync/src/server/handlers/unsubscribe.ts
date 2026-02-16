/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  UnsubscribeDocRequest,
  UnsubscribeDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";

export type UnsubscribeDocHandler = (
  payload: UnsubscribeDocRequest,
  cb: (res: UnsubscribeDocResponse) => void,
) => void | Promise<void>;

type UnsubscribeDeps = {
  server: DocSyncServer;
  socket: ServerConnectionSocket<{}, {}>;
  clientId: string;
};

export function handleUnsubscribeDoc({
  server,
  socket,
  clientId,
}: UnsubscribeDeps): void {
  const socketToDocsMap = server["_socketToDocsMap"];
  const presenceByDoc = server["_presenceByDoc"];

  const handler: UnsubscribeDocHandler = async (
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

    cb({ success: true });
  };

  socket.on("unsubscribe-doc", handler);
}
