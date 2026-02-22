import type { PresenceRequest, PresenceResponse } from "../../shared/types.js";
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
>({ server }: { server: DocSyncServer<TContext, D, S, O> }): void {
  const io = server["_io"];

  io.on("connection", (socket) => {
    socket.on(
      "presence",
      async (
        { docId, presence }: PresenceRequest,
        cb: (res: PresenceResponse) => void,
      ): Promise<void> => {
        applyPresenceUpdate(server["_presenceByDoc"], socket, {
          docId,
          presence,
        });
        cb({ data: void undefined });
      },
    );
  });
}
