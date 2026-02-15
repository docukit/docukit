import type { DocSyncEventName, Result } from "../../shared/types.js";

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

type PresenceDeps<TContext> = {
  socket: PresenceSocket;
  userId: string;
  context: TContext;
  authorize?:
    | ((ev: {
        type: DocSyncEventName;
        payload: unknown;
        userId: string;
        context: TContext;
      }) => Promise<boolean>)
    | undefined;
  applyPresenceUpdate: (args: { docId: string; presence: unknown }) => void;
};

export function handlePresence<TContext>({
  socket,
  userId,
  context,
  authorize,
  applyPresenceUpdate,
}: PresenceDeps<TContext>): void {
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
