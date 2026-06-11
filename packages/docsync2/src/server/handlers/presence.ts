import type { PresenceRequest, PresenceResponse } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import * as v from "valibot";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";
import { createValidationError } from "./validation.js";
import { presenceRequestSchema } from "../../shared/validators/socketProtocol.js";

export type PresenceHandler = (
  payload: PresenceRequest,
  cb: (res: PresenceResponse) => void,
) => void | Promise<void>;

export function handlePresence<
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
  socket.on(
    "presence",
    async (
      rawReq: unknown,
      cb: (res: PresenceResponse) => void,
    ): Promise<void> => {
      let req: PresenceRequest;
      try {
        req = v.parse(presenceRequestSchema, rawReq);
      } catch (error) {
        cb({ error: createValidationError(error) });
        return;
      }

      const { docId, presence } = req;
      const { userId, context } = socket.data;
      const authorized = server["_authorize"]
        ? await server["_authorize"]({ type: "presence", req, userId, context })
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
