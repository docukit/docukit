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
import { handleAuthAndConnect } from "./handlers/connection/authAndConnect.js";
import { handleDeleteDoc } from "./handlers/deleteDoc.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handlePresence } from "./handlers/presence.js";
import { handleSync } from "./handlers/sync/handleSync.js";
import { handleUnsubscribeDoc } from "./handlers/unsubscribe.js";

export class DocSyncServer<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  private _io: ServerSocket<S, O, TContext>;
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
      cors: { origin: "*" },
      // Performance: Only WebSocket transport, no polling
      transports: ["websocket"],
    });

    this._docBinding = config.docBinding;
    this._provider = new config.provider();
    this._authenticate = config.authenticate.bind(config);
    this._authorize = config.authorize?.bind(config);

    // Setup socket server
    const server = this;
    handleAuthAndConnect(server, (socket) => {
      handleDisconnect({ server, socket });
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
