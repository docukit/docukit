import { Server } from "socket.io";
import * as v from "valibot";
import type { Presence } from "../shared/types.js";
import type {
  AuthenticatedSocketData,
  ClientConnectEventListener,
  ClientDisconnectEventListener,
  DocSubscribeEventListener,
  DocUnsubscribeEventListener,
  ServerConfig,
  ServerProvider,
  ServerSocket,
  SyncRequestEventListener,
  Validators,
} from "./types.js";
import { handleDeleteDoc } from "./handlers/deleteDoc.js";
import { handleDisconnect } from "./handlers/disconnect.js";
import { handlePresence } from "./handlers/presence.js";
import { handleSync } from "./handlers/sync.js";
import { handleUnsubscribeDoc } from "./handlers/unsubscribe.js";
import { startupLog } from "./utils/startupLog.js";
import { socketAuthSchema } from "../shared/validators/socketProtocol.js";

export class DocSyncServer<
  TContext extends object = object,
  S extends object = object,
  O extends object = object,
> {
  private _io: ServerSocket<TContext, S, O>;
  private _provider: ServerProvider<S, O>;
  private _validators: Validators<S, O>;
  private _authenticate: ServerConfig<TContext, S, O>["authenticate"];
  private _authorize?: ServerConfig<TContext, S, O>["authorize"];
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
  private _docSubscribeEventListeners = new Set<DocSubscribeEventListener>();
  private _docUnsubscribeEventListeners =
    new Set<DocUnsubscribeEventListener>();
  private _syncRequestEventListeners = new Set<SyncRequestEventListener>();

  constructor(config: ServerConfig<TContext, S, O>) {
    const port = config.port ?? 8080;

    this._io = new Server(port, {
      cors: { origin: "*" },
      // Performance: Only WebSocket transport, no polling
      transports: ["websocket"],
    });
    console.log(startupLog(port));

    this._provider = config.provider;
    this._validators = config.validators;
    this._authenticate = config.authenticate.bind(config);
    this._authorize = config.authorize?.bind(config);
    this._setupSocketServer();
  }

  private _setupSocketServer() {
    // Middleware: authenticate before allowing connection
    this._io.use((socket, next) => {
      const parsedAuth = v.safeParse(socketAuthSchema, socket.handshake.auth);
      if (!parsedAuth.success) {
        next(new Error("Authentication required"));
        return;
      }

      const { token, deviceId, clientId, claimedUserId } = parsedAuth.output;
      const hasClaimedUserId =
        claimedUserId !== null && claimedUserId !== undefined;

      const authenticateInput = {
        request: socket.request,
        ...(token === undefined ? {} : { token }),
      };

      Promise.resolve(this._authenticate(authenticateInput))
        .then((authResult) => {
          if (!authResult) {
            next(new Error("Authentication failed: invalid credentials"));
            return;
          }

          if (hasClaimedUserId && authResult.userId !== claimedUserId) {
            next(new Error("Authentication failed: claimed user ID mismatch"));
            return;
          }

          // Attach authenticated context to socket data
          socket.data = {
            userId: authResult.userId,
            deviceId,
            clientId,
            context: authResult.context ?? ({} as TContext),
          } satisfies AuthenticatedSocketData<TContext>;

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
          clientId: "unknown",
          reason: `Authentication failed: ${err.message}`,
        });
      },
    );

    this._io.on("connection", (socket) => {
      const { userId, deviceId, clientId, context } = socket.data;

      socket.emit("identity", { userId });

      // Emit client connect event
      this._emit(this._clientConnectEventListeners, {
        userId,
        deviceId,
        clientId,
        context,
      });

      const server = this;
      handleDisconnect({ server, socket });
      // prettier-ignore
      handleSync({ server, socket });
      handleUnsubscribeDoc({ server, socket });
      handlePresence({ server, socket });
      handleDeleteDoc({ server, socket });
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
   * Register a listener for document subscription events.
   * @returns Unsubscribe function
   */
  onDocSubscribe(listener: DocSubscribeEventListener): () => void {
    this._docSubscribeEventListeners.add(listener);
    return () => {
      this._docSubscribeEventListeners.delete(listener);
    };
  }

  /**
   * Register a listener for document unsubscription events.
   * @returns Unsubscribe function
   */
  onDocUnsubscribe(listener: DocUnsubscribeEventListener): () => void {
    this._docUnsubscribeEventListeners.add(listener);
    return () => {
      this._docUnsubscribeEventListeners.delete(listener);
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
