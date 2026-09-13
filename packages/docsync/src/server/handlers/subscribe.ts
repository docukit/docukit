import type {
  SubscribeDocRequest,
  SubscribeDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { subscribeSocketToDoc } from "../utils/subscribeSocketToDoc.js";

export type SubscribeDocHandler = (
  payload: SubscribeDocRequest,
  cb: (res: SubscribeDocResponse) => void,
) => void | Promise<void>;

/**
 * Subscribes a client to a document without syncing it. A sync subscribes as
 * a side effect; a client that follows a document another tab syncs, and
 * therefore never syncs it itself, subscribes this way to keep receiving its
 * presence and collaboration updates.
 */
export function handleSubscribeDoc<
  TContext = unknown,
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
  userId,
  deviceId,
  clientId,
  context,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  userId: string;
  deviceId: string;
  clientId: string;
  context: TContext;
}): void {
  socket.on(
    "subscribe-doc",
    async (
      req: SubscribeDocRequest,
      cb: (res: SubscribeDocResponse) => void,
    ): Promise<void> => {
      const authorized = server["_authorize"]
        ? await server["_authorize"]({
            type: "subscribe-doc",
            req,
            userId,
            context,
          })
        : true;
      if (!authorized) {
        cb({ success: false });
        return;
      }
      await subscribeSocketToDoc({
        server,
        socket,
        userId,
        deviceId,
        clientId,
        docId: req.docId,
      });
      cb({ success: true });
    },
  );
}
