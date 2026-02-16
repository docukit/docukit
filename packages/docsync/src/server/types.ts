/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  ClientToServerEvents,
  DocBinding,
  DocSyncEventName,
  ServerToClientEvents,
  SerializedDocPayload,
} from "../shared/types.js";

// ============================================================================
// Server Events
// ============================================================================

/** Emitted when client successfully authenticates and connects */
export type ClientConnectEvent<TContext = unknown> = {
  userId: string;
  deviceId: string;
  socketId: string;
  context: TContext;
};

/**
 * Emitted when client disconnects.
 *
 * Also emitted when a connection attempt fails (e.g., authentication failure).
 * In that case, userId and deviceId may not be available.
 */
export type ClientDisconnectEvent = {
  userId: string;
  deviceId: string;
  socketId: string;
  reason: string;
};

/** Emitted once after sync request completes. */
export type SyncRequestEvent<O = unknown, S = unknown> = {
  userId: string;
  deviceId: string;
  socketId: string;
  status: "success" | "error";

  req: {
    docId: string;
    operations?: O[];
    clock: number;
    presence?: unknown;
  };

  res?: {
    operations?: O[];
    clock?: number;
    serializedDoc?: S;
  };

  durationMs?: number;
  devicesCount?: number;
  clientsCount?: number;

  error?: {
    type: "AuthorizationError" | "DatabaseError" | "ValidationError";
    message: string;
    stack?: string;
  };
};

export type ClientConnectEventListener<TContext = unknown> = (
  event: ClientConnectEvent<TContext>,
) => void;
export type ClientDisconnectEventListener = (
  event: ClientDisconnectEvent,
) => void;
export type SyncRequestEventListener<O = unknown, S = unknown> = (
  event: SyncRequestEvent<O, S>,
) => void;

// ============================================================================
// Server Config
// ============================================================================

/**
 * Server configuration with generic context type.
 *
 * @typeParam TContext - Application-defined context shape returned by authenticate
 *                       and passed to authorize. Defaults to empty object.
 */
export type ServerConfig<TContext, D extends {}, S extends {}, O extends {}> = {
  docBinding: DocBinding<D, S, O>;
  port?: number;
  provider: new () => ServerProvider<NoInfer<S>, NoInfer<O>>;

  authenticate(ev: { token: string }): Promise<
    | {
        userId: string;
        context?: TContext;
      }
    | undefined
  >;

  authorize?(ev: {
    type: DocSyncEventName;
    payload: unknown;
    userId: string;
    context: TContext;
  }): Promise<boolean>;
};

// ============================================================================
// Server Provider
// ============================================================================

/**
 * Context passed to server transaction callbacks.
 * All operations share the same underlying transaction.
 */
// prettier-ignore
export type ServerProviderContext<S, O> = {
  getSerializedDoc(docId: string): Promise<{ serializedDoc: S; clock: number } | undefined>;
  getOperations(arg: { docId: string; clock: number }): Promise<O[][]>;
  deleteOperations(arg: { docId: string; count: number }): Promise<void>;
  saveOperations(arg: { docId: string; operations: O[] }): Promise<number>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
};

/**
 * Storage provider for the server.
 * All operations must be performed within a transaction.
 */
export type ServerProvider<S, O> = {
  transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: ServerProviderContext<S, O>) => Promise<T>,
  ): Promise<T>;
};

// ============================================================================
// Socket (server)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- type-only reference to socket.io
export type ServerSocket<S, O> = import("socket.io").Server<
  ClientToServerEvents<S, O>,
  ServerToClientEvents
>;

/** Per-connection socket on the server (has .id, .join, .emit, .on, etc.). */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- type-only reference to socket.io
export type ServerConnectionSocket<S, O> = import("socket.io").Socket<
  ClientToServerEvents<S, O>,
  ServerToClientEvents
>;
