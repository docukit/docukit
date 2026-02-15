/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { Result } from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";

export type PresenceRequest = { docId: string; presence: unknown };
export type PresenceResponse = Result<
  void,
  { type: "AuthorizationError"; message: string }
>;
export type PresenceHandler = (
  payload: PresenceRequest,
  cb: (res: PresenceResponse) => void,
) => void | Promise<void>;

type PresenceSocket = {
  on: (event: "presence", handler: PresenceHandler) => void;
};

type PresenceDeps<TContext = {}> = {
  server: DocSyncServer<TContext>;
  socket: PresenceSocket;
  userId: string;
  context: TContext;
  applyPresenceUpdate: (args: { docId: string; presence: unknown }) => void;
};

export function handlePresence({
  server,
  socket,
  userId,
  context,
  applyPresenceUpdate,
}: PresenceDeps): void {
  const authorize = server["_authorize"];
  const authorizePresence = async (
    payload: PresenceRequest,
  ): Promise<boolean> => {
    if (!authorize) return true;
    return authorize({
      type: "presence",
      payload,
      userId,
      context,
    });
  };

  const handler: PresenceHandler = async (
    { docId, presence }: PresenceRequest,
    cb: (res: PresenceResponse) => void,
  ): Promise<void> => {
    const authorized = await authorizePresence({ docId, presence });
    if (!authorized) {
      cb({
        error: {
          type: "AuthorizationError",
          message: "Access denied",
        },
      });
      return;
    }
    applyPresenceUpdate({ docId, presence });
    cb({ data: void undefined });
  };

  socket.on("presence", handler);
}
