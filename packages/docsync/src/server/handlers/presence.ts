/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { PresenceRequest, PresenceResponse } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";

export type PresenceHandler = (
  payload: PresenceRequest,
  cb: (res: PresenceResponse) => void,
) => void | Promise<void>;

export function handlePresence<
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
  socket.on(
    "presence",
    async (
      { docId, presence }: PresenceRequest,
      cb: (res: PresenceResponse) => void,
    ): Promise<void> => {
      const payload: PresenceRequest = { docId, presence };
      const { userId, context } = socket.data;
      const authorized = server["_authorize"]
        ? await server["_authorize"]({
            type: "presence",
            payload,
            userId,
            context,
          })
        : true;
      if (!authorized) {
        cb({ error: { type: "AuthorizationError", message: "Access denied" } });
        return;
      }
      applyPresenceUpdate(server["_presenceByDoc"], socket, {
        docId,
        presence,
      });
      cb({ data: void undefined });
    },
  );
}
