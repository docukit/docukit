/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Server } from "socket.io";
import {
  type ServerSocket,
  type SocketHandlers,
  type DocSyncEventName,
  type AuthorizeEvent,
} from "../shared/types.js";
import type { ServerConfig } from "./types.js";
import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type { ClientProvider } from "../client/types.js";

type AuthenticatedContext<TContext> = {
  userId: string;
  deviceId: string;
  context: TContext;
};

const OPERATION_THRESHOLD = 100;

export class DocSyncServer<
  TContext,
  D extends {},
  S extends SerializedDoc,
  O extends {},
> {
  private _io: ServerSocket<S, O>;
  private _docBinding: DocBinding<D, S, O>;
  private _provider: ClientProvider<S, O, "server">;
  private _authenticate: ServerConfig<TContext, D, S, O>["authenticate"];
  private _authorize?: ServerConfig<TContext, D, S, O>["authorize"];
  // TODO: see comment in sync-operations
  private _LRUCache = new Map<string, { deviceId: string; clock: number }>();

  constructor(config: ServerConfig<TContext, D, S, O>) {
    this._io = new Server(config.port ?? 8080, {
      cors: {
        origin: "*",
      },
      // Performance: Only WebSocket transport, no polling
      transports: ["websocket"],
    });

    this._docBinding = config.docBinding;
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
              serializedDoc: null,
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

          // TODO: cache documents that have not been modified for append
          // only operations without performing read operations
          const result = await this._provider.transaction(
            "readwrite",
            async (ctx) => {
              const { docId, clock, operations } = payload;
              // 1. Get operations the client doesn't have (clock > clientClock)
              //    We query BEFORE inserting so we don't return the client's own operations
              const serverOps = await ctx.getOperations({ docId, clock });

              // 2. Get server document only if its clock > client clock
              const serverDoc = await ctx.getSerializedDoc(docId);

              // 3. Save client operations if provided (returns the new clock)
              const newClock = await ctx.saveOperations({
                docId,
                operations: operations ?? [],
              });

              // 4. Return data
              return {
                docId,
                operations: serverOps.length > 0 ? serverOps.flat() : null,
                serializedDoc: serverDoc?.serializedDoc ?? null,
                clock: newClock,
              };
            },
          );
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

          // Squash operations if threshold is reached
          if (
            result.operations &&
            result.operations.length >= OPERATION_THRESHOLD
          ) {
            const {
              docId,
              operations: serverOps,
              serializedDoc,
              clock,
            } = result;
            const operations = [...serverOps, ...(payload.operations ?? [])];
            const doc = serializedDoc
              ? this._docBinding.deserialize(serializedDoc)
              : this._docBinding.new("test", docId).doc;
            operations?.forEach((operation) => {
              this._docBinding.applyOperations(doc, operation);
            });
            const newSerializedDoc = this._docBinding.serialize(doc);
            await this._provider.transaction("readwrite", async (ctx) => {
              await ctx.saveSerializedDoc({
                docId,
                serializedDoc: newSerializedDoc,
                clock,
              });
              await ctx.deleteOperations({ docId, count: 1 });
            });
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
   * Emit a debug log to all connected clients.
   */
  private _log(arg: unknown) {
    this._io.emit("_log", arg);
  }

  /**
   * Close the server and all connections.
   */
  async close(): Promise<void> {
    await this._io.close();
  }
}
