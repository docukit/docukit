import type {
  ClientToServerEvents,
  DocBinding,
  DocSyncEventName,
  MaybePromise,
  ServerToClientEvents,
  SerializedDocPayload,
} from "../shared/types.js";
import type { Server, Socket } from "socket.io";

// ============================================================================
// Server Events
// ============================================================================

/** Emitted when client successfully authenticates and connects */
export type ClientConnectEvent<TContext = unknown> = {
  userId: string;
  deviceId: string;
  clientId: string;
  context: TContext;
};

/**
 * Emitted when client disconnects.
 *
 * Also emitted when a connection attempt fails (e.g., authentication failure).
 * In that case, userId, deviceId, and clientId may not be available.
 */
export type ClientDisconnectEvent = {
  userId: string;
  deviceId: string;
  clientId: string;
  reason: string;
};

/** Emitted when a connected client subscribes to a document. */
export type DocSubscribeEvent = {
  userId: string;
  deviceId: string;
  clientId: string;
  docId: string;
};

/** Emitted when a connected client unsubscribes from a document. */
export type DocUnsubscribeEvent = {
  userId: string;
  deviceId: string;
  clientId: string;
  docId: string;
  reason: string;
};

/** Emitted once after sync request completes. */
export type SyncRequestEvent<O = unknown, S = unknown> = {
  userId: string;
  deviceId: string;
  clientId: string;
  status: "success" | "error";

  req: { type: string; docId: string; operations?: O[]; clock: number };

  res?: { operations?: O[]; clock?: number; serializedDoc?: S };

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
export type DocSubscribeEventListener = (event: DocSubscribeEvent) => void;
export type DocUnsubscribeEventListener = (event: DocUnsubscribeEvent) => void;
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
export type ServerConfig<
  TContext,
  D extends object,
  S extends object,
  O extends object,
> = {
  docBinding: DocBinding<D, S, O>;
  port?: number;
  provider: ServerProvider<NoInfer<S>, NoInfer<O>>;

  authenticate(ev: {
    token: string;
  }): MaybePromise<{ userId: string; context?: TContext } | undefined>;

  authorize?(ev: {
    type: DocSyncEventName;
    req: unknown;
    userId: string;
    context: TContext;
  }): MaybePromise<boolean>;
};

// ============================================================================
// Server Provider
// ============================================================================

/**
 * Context passed to server transaction callbacks.
 * All operations share the same underlying transaction.
 */
// prettier-ignore
export type ServerProviderContext<S extends object, O extends object> = {
  getSerializedDoc(arg: { docId: string }): Promise<{ serializedDoc: S; clock: number } | undefined>;
  getOperations(arg: { docId: string; clock: number }): Promise<O[][]>;
  deleteOperations(arg: { docId: string; count: number }): Promise<void>;
  saveOperations(arg: { docId: string; operations: O[] }): Promise<number>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
};

/**
 * Storage provider for the server.
 * All operations must be performed within a transaction.
 */
export type ServerProvider<S extends object, O extends object> = {
  transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: ServerProviderContext<S, O>) => Promise<T>,
  ): Promise<T>;
};

// ============================================================================
// Socket (server)
// ============================================================================

export type AuthenticatedSocketData<TContext = unknown> = {
  userId: string;
  deviceId: string;
  /** Client-generated id for presence (set from auth or socket.id in connection flow) */
  clientId: string;
  context: TContext;
};

export type ServerSocket<
  TContext = unknown,
  S extends object = object,
  O extends object = object,
> = Server<
  ClientToServerEvents<S, O>,
  ServerToClientEvents,
  Record<string, never>,
  AuthenticatedSocketData<TContext>
>;

/** Per-connection socket on the server (has .id, .join, .emit, .on, etc.). */
export type ServerConnectionSocket<
  TContext = unknown,
  S extends object = object,
  O extends object = object,
> = Socket<
  ClientToServerEvents<S, O>,
  ServerToClientEvents,
  Record<string, never>,
  AuthenticatedSocketData<TContext>
>;
