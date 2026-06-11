import type {
  UnsubscribeDocRequest,
  UnsubscribeDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import * as v from "valibot";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";
import { broadcastCollaborationState } from "../utils/broadcastCollaborationState.js";
import { unsubscribeDocRequestSchema } from "../../shared/validators/socketProtocol.js";
import { createValidationError } from "./validation.js";

export type UnsubscribeDocHandler = (
  payload: UnsubscribeDocRequest,
  cb: (res: UnsubscribeDocResponse) => void,
) => void | Promise<void>;

export function handleUnsubscribeDoc<
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
  const socketToDocsMap = server["_socketToDocsMap"];
  const presenceByDoc = server["_presenceByDoc"];

  socket.on(
    "unsubscribe-doc",
    async (
      rawReq: unknown,
      cb: (res: UnsubscribeDocResponse) => void,
    ): Promise<void> => {
      let req: UnsubscribeDocRequest;
      try {
        req = v.parse(unsubscribeDocRequestSchema, rawReq);
      } catch (error) {
        cb({ error: createValidationError(error) });
        return;
      }

      const { docId } = req;
      await socket.leave(`doc:${docId}`);

      const subscribedDocs = socketToDocsMap.get(socket.id);
      if (subscribedDocs) {
        subscribedDocs.delete(docId);
        if (subscribedDocs.size === 0) {
          socketToDocsMap.delete(socket.id);
        }
      }

      applyPresenceUpdate(presenceByDoc, socket, { docId, presence: null });
      broadcastCollaborationState(server, docId);

      cb({ data: void undefined });
    },
  );
}
