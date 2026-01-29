/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Server } from "socket.io";
import {
  type ServerSocket,
  type SocketHandlers,
  type DocSyncEventName,
  type AuthorizeEvent,
  type ServerConfig,
  type Provider,
  type ClientConnectHandler,
  type ClientDisconnectHandler,
  type SyncRequestHandler,
  type Presence,
} from "../shared/types.js";
import type { DocBinding } from "../shared/docBinding.js";

type AuthenticatedContext<TContext> = {
  userId: string;
  deviceId: string;
  context: TContext;
};

const OPERATION_THRESHOLD = 100;

export class DocSyncServer<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  private _io: ServerSocket<S, O>;
  private _docBinding: DocBinding<D, S, O>;
  private _provider: Provider<S, O, "server">;
  private _authenticate: ServerConfig<TContext, D, S, O>["authenticate"];
  private _authorize?: ServerConfig<TContext, D, S, O>["authorize"];
  // TODO: see comment in sync-operations
  private _LRUCache = new Map<string, { deviceId: string; clock: number }>();
  // Track presence state per document: docId -> Record<userId, presence data>
  private _presenceByDoc = new Map<string, Presence>();

  // Event handlers
  private _clientConnectHandlers = new Set<ClientConnectHandler<TContext>>();
  private _clientDisconnectHandlers = new Set<ClientDisconnectHandler>();
  private _syncRequestHandlers = new Set<SyncRequestHandler<O, S>>();

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
    this._authenticate = config.authenticate.bind(config);
    this._authorize = config.authorize?.bind(config);
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

    // Handle connection errors (auth failures)
    this._io.engine.on(
      "connection_error",
      (err: { req: { _query?: { deviceId?: string } }; message: string }) => {
        // Try to extract deviceId from the failed connection request
        const deviceId = err.req._query?.deviceId ?? "unknown";
        this._emit(this._clientDisconnectHandlers, {
          userId: "unknown",
          deviceId,
          socketId: "unknown",
          reason: `Authentication failed: ${err.message}`,
        });
      },
    );

    this._io.on("connection", (socket) => {
      const { userId, deviceId, context } =
        socket.data as AuthenticatedContext<TContext>;

      // Emit client connect event
      this._emit(this._clientConnectHandlers, {
        userId,
        deviceId,
        socketId: socket.id,
        context,
      });

      // Handle disconnect
      socket.on("disconnect", (reason) => {
        // Clean up presence for all documents this socket was in
        for (const [docId, presenceForDoc] of this._presenceByDoc.entries()) {
          if (presenceForDoc[socket.id] !== undefined) {
            // Broadcast presence removal
            socket.to(`doc:${docId}`).emit("presence", {
              docId,
              presence: { [socket.id]: undefined },
            });
            delete presenceForDoc[socket.id];
            if (Object.keys(presenceForDoc).length === 0) {
              this._presenceByDoc.delete(docId);
            }
          }
        }

        this._emit(this._clientDisconnectHandlers, {
          userId,
          deviceId,
          socketId: socket.id,
          reason,
        });
      });

      // Helper to check authorization
      const checkAuth = async (
        event: AuthorizeEvent<TContext, S, O>,
      ): Promise<boolean> => {
        if (!this._authorize) return true;
        return this._authorize(event);
      };

      // TypeScript errors if any handler is missing
      const handlers: SocketHandlers<S, O> = {
        "sync-operations": async (payload, cb) => {
          const { docId, operations = [], clock } = payload;
          const startTime = Date.now();

          const authorized = await checkAuth({
            type: "sync-operations",
            payload,
            userId,
            context,
          });
          if (!authorized) {
            const errorEvent = {
              type: "AuthorizationError" as const,
              message: "Access denied",
            };

            // Emit sync request event with authorization error
            this._emit(this._syncRequestHandlers, {
              userId,
              deviceId,
              socketId: socket.id,
              status: "error",
              req: payload,
              error: errorEvent,
              durationMs: Date.now() - startTime,
            });

            // Return error response
            cb({
              error: errorEvent,
            });
            return;
          }

          // Auto-subscribe to the document room on first sync
          const room = this._io.sockets.adapter.rooms.get(`doc:${docId}`);
          if (!room?.has(socket.id)) {
            await socket.join(`doc:${docId}`);

            // Send current presence state to newly joined client
            const presence = this._presenceByDoc.get(docId);
            if (presence) socket.emit("presence", { docId, presence });
          }

          try {
            // TODO: cache documents that have not been modified for append
            // only operations without performing read operations
            // TODO: with caching, ensure we don't save two operations for the same docId
            // in the same millisecond to avoid PRIMARY KEY (docId, clock) conflicts
            const result = await this._provider.transaction(
              "readwrite",
              async (ctx) => {
                // 1. Get operations the client doesn't have (clock > clientClock)
                //    We query BEFORE inserting so we don't return the client's own operations
                const serverOps = await ctx.getOperations({ docId, clock });

                // 2. Get server document only if its clock > client clock
                const serverDoc = await ctx.getSerializedDoc(docId);

                // 3. Save client operations if provided (returns the new clock)
                const newClock = await ctx.saveOperations({
                  docId,
                  operations,
                });

                // 4. Return data
                return {
                  docId,
                  ...(serverOps.length > 0
                    ? { operations: serverOps.flat() }
                    : {}),
                  ...(serverDoc?.serializedDoc
                    ? { serializedDoc: serverDoc.serializedDoc }
                    : {}),
                  clock: newClock,
                };
              },
            );

            // Return success response
            cb({
              data: {
                docId: result.docId,
                ...(result.operations ? { operations: result.operations } : {}),
                ...(result.serializedDoc
                  ? { serializedDoc: result.serializedDoc }
                  : {}),
                clock: result.clock,
              },
            });

            // Get collaboration metrics and notify other clients in single pass
            const docRoom = this._io.sockets.adapter.rooms.get(
              `doc:${payload.docId}`,
            );
            const devicesInRoom = new Set<string>();
            const shouldNotifyClients =
              payload.operations && payload.operations.length > 0;

            if (docRoom) {
              for (const socketId of docRoom) {
                const targetSocket = this._io.sockets.sockets.get(socketId);
                if (!targetSocket) continue;

                const targetDeviceId = (
                  targetSocket.data as AuthenticatedContext<TContext>
                ).deviceId;

                // Collect device IDs for metrics
                devicesInRoom.add(targetDeviceId);

                // Notify other clients (skip sender and same device)
                if (shouldNotifyClients) {
                  if (
                    targetSocket.id !== socket.id &&
                    targetDeviceId !== deviceId
                  ) {
                    targetSocket.emit("dirty", { docId: payload.docId });
                  }
                }
              }
            }

            // Emit sync request event (success)
            this._emit(this._syncRequestHandlers, {
              userId,
              deviceId,
              socketId: socket.id,
              status: "success",
              req: {
                docId: payload.docId,
                operations,
                clock: payload.clock,
              },
              ...(result.operations || result.serializedDoc
                ? {
                    res: {
                      ...(result.operations
                        ? { operations: result.operations }
                        : {}),
                      ...(result.serializedDoc
                        ? { serializedDoc: result.serializedDoc }
                        : {}),
                      clock: result.clock,
                    },
                  }
                : {}),
              durationMs: Date.now() - startTime,
              clientsCount: docRoom?.size ?? 0,
              devicesCount: devicesInRoom.size,
            });

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
                : this._docBinding.create("test", docId).doc;
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
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);

            const errorEvent = {
              type: "DatabaseError" as const,
              message: errorMessage,
            };

            // Emit sync request event with error
            this._emit(this._syncRequestHandlers, {
              userId,
              deviceId,
              socketId: socket.id,
              status: "error",
              req: {
                docId: payload.docId,
                operations,
                clock: payload.clock,
              },
              error: {
                ...errorEvent,
                ...(error instanceof Error && error.stack
                  ? { stack: error.stack }
                  : {}),
              },
              durationMs: Date.now() - startTime,
            });

            // Return error response
            cb({
              error: errorEvent,
            });
            return;
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
        "unsubscribe-doc": async ({ docId }, cb) => {
          // Leave the room for this document
          await socket.leave(`doc:${docId}`);

          // Clean up presence state for this socket in this document
          const presenceForDoc = this._presenceByDoc.get(docId);
          if (presenceForDoc) {
            // Broadcast presence removal before deleting
            if (presenceForDoc[socket.id] !== undefined) {
              socket.to(`doc:${docId}`).emit("presence", {
                docId,
                presence: { [socket.id]: undefined },
              });
            }
            delete presenceForDoc[socket.id];
            // Only delete the map entry if no sockets remain
            if (Object.keys(presenceForDoc).length === 0) {
              this._presenceByDoc.delete(docId);
            }
          }

          cb({ success: true });
        },
        presence: async ({ docId, presence }, cb) => {
          // Use socket.id as the unique presence key (each connection is unique)
          const presencePatch = { [socket.id]: presence };

          // Update server's presence state for this document
          const currentPresence = this._presenceByDoc.get(docId) ?? {};
          const newPresence = { ...currentPresence, ...presencePatch };
          this._presenceByDoc.set(docId, newPresence);

          // Broadcast to all clients in the room EXCEPT the sender
          socket
            .to(`doc:${docId}`)
            .emit("presence", { docId, presence: presencePatch });

          // Return success
          cb({ data: void undefined });
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

  // ============================================================================
  // Event Registration Methods
  // ============================================================================

  /**
   * Register a handler for client connection events.
   * @returns Unsubscribe function
   */
  onClientConnect(handler: ClientConnectHandler<TContext>): () => void {
    this._clientConnectHandlers.add(handler);
    return () => {
      this._clientConnectHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for client disconnection events.
   * @returns Unsubscribe function
   */
  onClientDisconnect(handler: ClientDisconnectHandler): () => void {
    this._clientDisconnectHandlers.add(handler);
    return () => {
      this._clientDisconnectHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for sync request events.
   * @returns Unsubscribe function
   */
  onSyncRequest(handler: SyncRequestHandler<O, S>): () => void {
    this._syncRequestHandlers.add(handler);
    return () => {
      this._syncRequestHandlers.delete(handler);
    };
  }

  // ============================================================================
  // Event Emitters (private methods)
  // ============================================================================

  private _emit<T>(handlers: Set<(event: T) => void>, event: T) {
    for (const handler of handlers) {
      handler(event);
    }
  }
}
