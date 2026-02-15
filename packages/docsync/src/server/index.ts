/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Server } from "socket.io";
import {
  type ServerSocket,
  type ServerConfig,
  type Provider,
  type ClientConnectHandler,
  type ClientDisconnectHandler,
  type SyncRequestHandler,
  type Presence,
  type DocBinding,
} from "../shared/types.js";
import {
  createDeleteDocHandler,
  type DeleteDocRequest,
  type DeleteDocHandler,
} from "./handlers/delete-doc.js";
import { createPresenceHandler } from "./handlers/presence.js";
import {
  createSyncOperationsHandler,
  type SyncOperationsRequest,
} from "./handlers/sync.js";
import { createUnsubscribeDocHandler } from "./handlers/unsubscribe.js";

type AuthenticatedContext<TContext> = {
  userId: string;
  deviceId: string;
  /** Client-generated id for presence (set from auth or socket.id in connection handler) */
  clientId: string;
  context: TContext;
};

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
  // Track presence state per document: docId -> Record<clientId, presence data>
  private _presenceByDoc = new Map<string, Presence>();
  // Track which sockets are subscribed to which documents (for cleanup on disconnect)
  private _socketToDocsMap = new Map<string, Set<string>>();

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
      const { token, deviceId, clientId } = socket.handshake.auth;
      if (!token || typeof token !== "string") {
        next(new Error("Authentication required: no token provided"));
        return;
      }

      if (!deviceId || typeof deviceId !== "string") {
        next(new Error("Device ID required"));
        return;
      }

      // TODO: should I check that no one is using an already taken ID, presumably intentionally?
      if (!clientId || typeof clientId !== "string" || clientId.length === 0) {
        next(new Error("Client ID required"));
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
            clientId,
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
      const { userId, deviceId, clientId, context } =
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
        // Get all documents this socket was subscribed to
        const subscribedDocs = this._socketToDocsMap.get(socket.id);

        if (subscribedDocs) {
          // Clean up presence for all documents this socket was in
          for (const docId of subscribedDocs) {
            const presenceForDoc = this._presenceByDoc.get(docId);

            // Immediately broadcast removal to OTHER clients
            socket.to(`doc:${docId}`).emit("presence", {
              docId,
              presence: { [clientId]: null },
            });

            // Clean up presence map if the socket had presence
            if (presenceForDoc?.[clientId] !== undefined) {
              delete presenceForDoc[clientId];
              if (Object.keys(presenceForDoc).length === 0) {
                this._presenceByDoc.delete(docId);
              }
            }
          }

          // Remove socket from tracking map
          this._socketToDocsMap.delete(socket.id);
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
        event:
          | {
              type: "sync-operations";
              payload: SyncOperationsRequest<O>;
              userId: string;
              context: TContext;
            }
          | {
              type: "delete-doc";
              payload: DeleteDocRequest;
              userId: string;
              context: TContext;
            },
      ): Promise<boolean> => {
        if (!this._authorize) return true;
        return this._authorize(event);
      };

      const applyPresenceUpdate = ({
        docId,
        presence,
      }: {
        docId: string;
        presence: unknown;
      }) => {
        // Update server's presence state for this document
        const currentPresence = this._presenceByDoc.get(docId) ?? {};

        if (presence === null || presence === undefined) {
          // Delete the presence entry for this client
          delete currentPresence[clientId];
          // Only keep the map entry if there are other sockets with presence
          if (Object.keys(currentPresence).length > 0) {
            this._presenceByDoc.set(docId, currentPresence);
          } else {
            this._presenceByDoc.delete(docId);
          }
        } else {
          // Set the presence for this client
          const newPresence = { ...currentPresence, [clientId]: presence };
          this._presenceByDoc.set(docId, newPresence);
        }
        // Broadcast to other clients (undefined → null for JSON)
        socket.to(`doc:${docId}`).emit("presence", {
          docId,
          presence: { [clientId]: presence ?? null },
        });
      };

      const syncOperationsHandler = createSyncOperationsHandler<
        TContext,
        D,
        S,
        O
      >({
        io: this._io,
        socket,
        userId,
        deviceId,
        context,
        provider: this._provider,
        docBinding: this._docBinding,
        socketToDocsMap: this._socketToDocsMap,
        presenceByDoc: this._presenceByDoc,
        checkAuth,
        applyPresenceUpdate,
        emitSyncRequest: (event) =>
          this._emit(this._syncRequestHandlers, event),
      });
      const unsubscribeDocHandler = createUnsubscribeDocHandler({
        socket,
        clientId,
        socketToDocsMap: this._socketToDocsMap,
        presenceByDoc: this._presenceByDoc,
      });
      const presenceHandler = createPresenceHandler({
        applyPresenceUpdate,
      });
      const deleteDocHandler: DeleteDocHandler =
        createDeleteDocHandler<TContext>({
          userId,
          context,
          checkAuth,
        });

      socket.on("sync-operations", syncOperationsHandler);
      socket.on("delete-doc", deleteDocHandler);
      socket.on("unsubscribe-doc", unsubscribeDocHandler);
      socket.on("presence", presenceHandler);
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
