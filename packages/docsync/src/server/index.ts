/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Server } from "socket.io";
import type { DocBinding, Presence } from "../shared/types.js";
import type {
  ClientConnectEventListener,
  ClientDisconnectEventListener,
  ServerConfig,
  ServerProvider,
  ServerSocket,
  SyncRequestEventListener,
} from "./types.js";
import { handleDeleteDoc } from "./handlers/delete-doc.js";
import { handleDisconnect } from "./handlers/disconnect.js";
import { handlePresence } from "./handlers/presence.js";
import { handleSync } from "./handlers/sync.js";
import { handleUnsubscribeDoc } from "./handlers/unsubscribe.js";

type AuthenticatedContext<TContext = {}> = {
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
  private _provider: ServerProvider<S, O>;
  private _authenticate: ServerConfig<TContext, D, S, O>["authenticate"];
  private _authorize?: ServerConfig<TContext, D, S, O>["authorize"];
  // TODO: see comment in sync
  private _LRUCache = new Map<string, { deviceId: string; clock: number }>();
  // Track presence state per document: docId -> Record<clientId, presence data>
  private _presenceByDoc = new Map<string, Presence>();
  // Track which sockets are subscribed to which documents (for cleanup on disconnect)
  private _socketToDocsMap = new Map<string, Set<string>>();

  // Event listeners (observers); distinct from socket request/response handlers
  // ClientConnectEventListener and SyncRequestEventListener use default (unknown) to allow covariance
  private _clientConnectEventListeners = new Set<ClientConnectEventListener>();
  private _clientDisconnectEventListeners =
    new Set<ClientDisconnectEventListener>();
  private _syncRequestEventListeners = new Set<SyncRequestEventListener>();

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
        this._emit(this._clientDisconnectEventListeners, {
          userId: "unknown",
          deviceId,
          socketId: "unknown",
          reason: `Authentication failed: ${err.message}`,
        });
      },
    );

    this._io.on("connection", (socket) => {
      const { userId, deviceId, clientId, context } =
        socket.data as AuthenticatedContext;

      // Emit client connect event
      this._emit(this._clientConnectEventListeners, {
        userId,
        deviceId,
        socketId: socket.id,
        context,
      });

      const server = this as DocSyncServer;
      handleDisconnect({ server, socket, userId, deviceId, clientId });
      // prettier-ignore
      handleSync({ server, socket, userId, deviceId, clientId, context });
      handleUnsubscribeDoc({ server, socket, clientId });
      handlePresence({ server, socket, userId, clientId, context });
      handleDeleteDoc({ server, socket, userId, context });
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
   * Register a listener for client connection events.
   * @returns Unsubscribe function
   */
  onClientConnect(listener: ClientConnectEventListener<TContext>): () => void {
    this._clientConnectEventListeners.add(
      listener as ClientConnectEventListener,
    );
    return () => {
      this._clientConnectEventListeners.delete(
        listener as ClientConnectEventListener,
      );
    };
  }

  /**
   * Register a listener for client disconnection events.
   * @returns Unsubscribe function
   */
  onClientDisconnect(listener: ClientDisconnectEventListener): () => void {
    this._clientDisconnectEventListeners.add(listener);
    return () => {
      this._clientDisconnectEventListeners.delete(listener);
    };
  }

  /**
   * Register a listener for sync request events.
   * @returns Unsubscribe function
   */
  onSyncRequest(listener: SyncRequestEventListener<O, S>): () => void {
    this._syncRequestEventListeners.add(listener as SyncRequestEventListener);
    return () => {
      this._syncRequestEventListeners.delete(
        listener as SyncRequestEventListener,
      );
    };
  }

  // ============================================================================
  // Event Emitters (private methods)
  // ============================================================================

  protected _emit<T>(listeners: Set<(event: T) => void>, event: T) {
    for (const listener of listeners) {
      listener(event);
    }
  }
}
