import { Server } from "socket.io";
import {
  type ServerSocket,
  type SocketHandlers,
  type DocSyncEventName,
  type AuthorizeEvent,
} from "../shared/types.js";
import type { ServerConfig, ServerProvider } from "./types.js";

type AuthenticatedContext<TContext> = {
  userId: string;
  deviceId: string;
  context: TContext;
};

export class DocSyncServer<TContext, S, O> {
  private _io: ServerSocket<S, O>;
  private _provider: ServerProvider<S, O>;
  private _authenticate: ServerConfig<TContext, S, O>["authenticate"];
  private _authorize?: ServerConfig<TContext, S, O>["authorize"];

  constructor(config: ServerConfig<TContext, S, O>) {
    this._io = new Server(config.port ?? 8080, {
      cors: {
        origin: "*",
      },
      // Performance: Only WebSocket transport, no polling
      transports: ["websocket"],
    });
    this._provider = new config.provider();
    this._authenticate = config.authenticate;
    this._authorize = config.authorize;
    this._setupSocketServer();
  }

  private _setupSocketServer() {
    // Middleware: authenticate before allowing connection
    this._io.use((socket, next) => {
      const { token, deviceId } = socket.handshake.auth;
      if (!token || typeof token !== "string") {
        next(new Error("Authentication required: no token provided"));
        return;
      }

      if (!deviceId || typeof deviceId !== "string") {
        next(new Error("Device ID required"));
        return;
      }

      this._authenticate({ token })
        .then((authResult) => {
          if (!authResult) {
            next(new Error("Authentication failed: invalid token"));
            return;
          }

          // Attach authenticated context to socket data
          socket.data = {
            userId: authResult.userId,
            deviceId,
            context: authResult.context ?? ({} as TContext),
          } satisfies AuthenticatedContext<TContext>;

          next();
        })
        .catch((err: unknown) => {
          next(new Error(`Authentication error: ${String(err)}`));
        });
    });

    this._io.on("connection", (socket) => {
      const { userId, deviceId, context } =
        socket.data as AuthenticatedContext<TContext>;

      // socket.on("disconnect", (reason) =>
      //   console.log(`Client disconnected: ${reason}`),
      // );
      // socket.on("error", (err) => console.error("Socket.io error:", err));

      // Helper to check authorization
      const checkAuth = async (
        event: AuthorizeEvent<TContext, S, O>,
      ): Promise<boolean> => {
        if (!this._authorize) return true;
        return this._authorize(event);
      };

      // TypeScript errors if any handler is missing
      const handlers: SocketHandlers<S, O> = {
        "get-doc": async (payload, cb) => {
          const authorized = await checkAuth({
            type: "get-doc",
            payload,
            userId,
            context,
          });
          if (!authorized) {
            // console.log("Authorization denied for get-doc", {
            //   userId,
            //   payload,
            // });
            cb(undefined);
            return;
          }
          cb(undefined);
        },
        "sync-operations": async (payload, cb) => {
          const authorized = await checkAuth({
            type: "sync-operations",
            payload,
            userId,
            context,
          });
          if (!authorized) {
            // console.log("Authorization denied for sync-operations", {
            //   userId,
            //   payload,
            // });
            // Return empty response on auth failure
            cb({
              docId: payload.docId,
              operations: null,
              serializedDoc: null as S,
              clock: payload.clock,
            });
            return;
          }

          // Auto-subscribe to the document room on first sync
          const room = this._io.sockets.adapter.rooms.get(
            `doc:${payload.docId}`,
          );
          if (!room?.has(socket.id)) {
            await socket.join(`doc:${payload.docId}`);
          }

          const result = await this._provider.sync(payload);
          cb(result);

          // If client sent operations, notify other clients in the room
          // Exclude clients from the same device (same deviceId)
          if (payload.operations && payload.operations.length > 0) {
            const room = this._io.sockets.adapter.rooms.get(
              `doc:${payload.docId}`,
            );
            if (room) {
              for (const socketId of room) {
                const targetSocket = this._io.sockets.sockets.get(socketId);
                if (!targetSocket) continue;

                // Skip if it's the sender or same device
                if (
                  targetSocket.id === socket.id ||
                  (targetSocket.data as AuthenticatedContext<TContext>)
                    .deviceId === deviceId
                ) {
                  continue;
                }

                targetSocket.emit("dirty", { docId: payload.docId });
              }
            }
          }
        },
        "delete-doc": async (payload, cb) => {
          const authorized = await checkAuth({
            type: "delete-doc",
            payload,
            userId,
            context,
          });
          if (!authorized) {
            // console.log("Authorization denied for delete-doc", {
            //   userId,
            //   payload,
            // });
            cb({ success: false });
            return;
          }
          cb({ success: true });
        },
        "unsubscribe-doc": async (payload, cb) => {
          // Leave the room for this document
          await socket.leave(`doc:${payload.docId}`);
          // console.log(`User ${userId} unsubscribed from doc:${payload.docId}`);
          cb({ success: true });
        },
      };

      // Register handlers
      for (const event of Object.keys(handlers) as DocSyncEventName[]) {
        socket.on(event, handlers[event]);
      }
    });
  }

  /**
   * Close the server and all connections.
   */
  async close(): Promise<void> {
    await this._io.close();
  }
}
