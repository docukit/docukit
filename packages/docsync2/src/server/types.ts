import type {
  ClientToServerEvents,
  DocSyncEventName,
  MaybePromise,
  ServerToClientEvents,
  SyncRequest,
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

type SyncRequestEventBase = {
  userId: string;
  deviceId: string;
  socketId: string;
  durationMs?: number;
  devicesCount?: number;
  clientsCount?: number;
};

type SyncRequestEventError<T extends string> = {
  type: T;
  message: string;
  stack?: string;
};

/** Emitted once after sync request completes. */
export type SyncRequestEvent<O = unknown, S = unknown> =
  | (SyncRequestEventBase & {
      status: "success";
      req: SyncRequest<S, O>;
      res?: { operations?: O[]; clock?: number; serializedDoc?: S };
      error?: never;
    })
  | (SyncRequestEventBase & {
      status: "error";
      req: SyncRequest<S, O>;
      error: SyncRequestEventError<"AuthorizationError" | "DatabaseError">;
      res?: { operations?: O[]; clock?: number; serializedDoc?: S };
    })
  | (SyncRequestEventBase & {
      status: "error";
      req: unknown;
      error: SyncRequestEventError<"ValidationError">;
      res?: never;
    });

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

export type Validators<S extends object, O extends object> = {
  serializedDoc(input: unknown): S;
  operations(input: unknown): O;
};

export type AuthenticatedSocketData<TContext extends object = object> = {
  userId: string;
  deviceId: string;
  /** Client-generated id for presence (set from auth or socket.id in connection flow) */
  clientId: string;
  context: TContext;
};

/**
 * Server configuration with generic context type.
 *
 * @typeParam TContext - Application-defined context shape returned by authenticate
 *                       and passed to authorize.
 */
export type ServerConfig<
  TContext extends object,
  S extends object,
  O extends object,
> = {
  validators: Validators<S, O>;
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
  deleteOperationsUntil(arg: { docId: string; clock: number }): Promise<void>;
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

export type ServerSocket<
  TContext extends object = object,
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
  TContext extends object = object,
  S extends object = object,
  O extends object = object,
> = Socket<
  ClientToServerEvents<S, O>,
  ServerToClientEvents,
  Record<string, never>,
  AuthenticatedSocketData<TContext>
>;
