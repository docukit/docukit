// TODO: review this line! Importing socket.io and socket.io-client
// as dynamic imports produces environment pollution errors.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import type { DeleteDocHandler } from "../server/handlers/delete-doc.js";
import type { PresenceHandler } from "../server/handlers/presence.js";
import type { SyncHandler } from "../server/handlers/sync.js";
import type { UnsubscribeDocHandler } from "../server/handlers/unsubscribe.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
/**
 * DocSync Type Definitions
 *
 * This file contains all type definitions for the DocSync library.
 * It is organized into collapsible regions for better navigation.
 */

// TO-DECIDE: should params in fn's be objects?
export interface DocBinding<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  // method syntax is required to avoid type errors
  create(type: string, id?: string): { doc: D; docId: string };
  deserialize(serializedDoc: S): D;
  serialize(doc: D): S;
  onChange(doc: D, cb: (ev: { operations: O }) => void): void;
  applyOperations(doc: D, operations: O): void;
  dispose(doc: D): void;
}

// ============================================================================
// #region Monads
// ============================================================================

export type Result<D, E = Error> =
  | {
      data: D;
      error?: never;
    }
  | {
      data?: never;
      error: E;
    };

export type QueryResult<D, E = Error> =
  | {
      status: "loading";
      data?: never;
      error?: never;
    }
  | {
      status: "success";
      data: D;
      error?: never;
    }
  | {
      status: "error";
      data?: never;
      error: E;
    };

// #endregion

// ============================================================================
// #region DocSync Events (Request/Response)
// ============================================================================

export type DocSyncEventName =
  | "sync"
  | "presence"
  | "delete-doc"
  | "unsubscribe-doc";

/** Shared request payload for the sync event (client sends, server receives). */
export type SyncRequest<O = unknown> = {
  docId: string;
  operations?: O[];
  clock: number;
  presence?: unknown;
};

/** Shared response for the sync event (server sends, client receives). */
export type SyncResponse<S = unknown, O = unknown> = Result<
  {
    docId: string;
    operations?: O[];
    serializedDoc?: S;
    clock: number;
  },
  {
    type: "AuthorizationError" | "DatabaseError" | "ValidationError";
    message: string;
  }
>;

/** Shared request/response for the presence event. */
export type PresenceRequest = { docId: string; presence: unknown };
export type PresenceResponse = Result<
  void,
  { type: "AuthorizationError"; message: string }
>;

/** Shared request/response for the delete-doc event. */
export type DeleteDocRequest = { docId: string };
export type DeleteDocResponse = { success: boolean };

/** Shared request/response for the unsubscribe-doc event. */
export type UnsubscribeDocRequest = { docId: string };
export type UnsubscribeDocResponse = { success: boolean };

// #endregion

// ============================================================================
// #region Client Events
// ============================================================================

/**
 * Client-side event definitions.
 *
 * Based on "wide events" philosophy from loggingsucks.com:
 * 1. **Optional fields** added as they become available
 * 2. **Can have partial data** (error + partial response can coexist) - **SERVER EVENTS ONLY**
 * 3. **One operation = one event** (sync start + complete + error = single wide event)
 * 4. **Separate concerns = separate events** (connect ≠ disconnect)
 *
 * ## Events
 *
 * **Client (6):** `onConnect`, `onDisconnect`, `onChange`, `onSync`, `onDocLoad`, `onDocUnload`
 * **Server (3):** `onClientConnect`, `onClientDisconnect`, `onSyncRequest`
 *
 * **Wide events:** `onSyncRequest` (server)
 * **Strict Result events:** `onSync` (client) - uses Result type for mutually exclusive data/error
 */

/** Emitted when WebSocket connection is lost */
export type DisconnectEvent = {
  reason: string;
  // TODO: maybe in the future
  // willReconnect: boolean;
};

/** Emitted when document content changes */
export type ChangeEvent<O = unknown> = {
  docId: string;
  origin: "local" | "broadcast" | "remote";
  operations: O[];
};

/** Emitted once after sync completes (success or error). Same req/res contract as server; client may also get NetworkError. */
export type SyncEvent<O = unknown, S = unknown> = {
  req: SyncRequest<O>;
} & (
  | SyncResponse<S, O>
  | { error: { type: "NetworkError"; message: string }; data?: never }
);

/** Emitted when document is loaded */
export type DocLoadEvent = {
  docId: string;
  source: "cache" | "local" | "created";
  refCount: number;
};

/** Emitted when document is unloaded. If refCount is 0, the document is removed from the cache. */
export type DocUnloadEvent = {
  docId: string;
  refCount: number;
};

export type ConnectEventListener = () => void;
export type DisconnectEventListener = (event: DisconnectEvent) => void;
// Method syntax is required for bivariance to allow DocSyncClient<Doc, S, O> to be assignable to DocSyncClient<{}, {}, {}>
// Note: `out` cannot be used here because O is in contravariant position (function parameter).
// The covariance is achieved by storing Set<ChangeEventListener> (with default unknown) in the class,
// combined with method-level type parameters for type-safe public API.
// eslint-disable-next-line @typescript-eslint/prefer-function-type
export type ChangeEventListener<O = {}> = { (event: ChangeEvent<O>): void };
/** Client listener for when a sync completes (passed to {@link DocSyncClient.onSync}). */
// eslint-disable-next-line @typescript-eslint/prefer-function-type
export type SyncEventListener<O = {}> = { (event: SyncEvent<O>): void };
export type DocLoadEventListener = (event: DocLoadEvent) => void;
export type DocUnloadEventListener = (event: DocUnloadEvent) => void;

// #endregion

// ============================================================================
// #region Server Events
// ============================================================================

/**
 * Server-side event definitions.
 * These events follow the "wide events" philosophy for comprehensive logging.
 */

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
 *
 * Common `reason` values from Socket.IO:
 * - "transport close" - Connection lost
 * - "client namespace disconnect" - Client explicitly disconnected
 * - "server namespace disconnect" - Server closed connection
 * - "Authentication failed: invalid token" - Auth failed during connection attempt
 */
export type ClientDisconnectEvent = {
  userId: string;
  deviceId: string;
  socketId: string;
  reason: string;
};

/**
 * Emitted once after sync request completes.
 *
 * Common error.type values:
 * - "AuthorizationError" - Access denied (authorization failed)
 * - "DatabaseError" - Database operation failed
 * - "ValidationError" - Invalid request data
 */
export type SyncRequestEvent<O = unknown, S = unknown> = {
  // Core fields (always present)
  userId: string;
  deviceId: string;
  socketId: string;
  status: "success" | "error";

  // Request context (always present)
  req: {
    docId: string;
    operations?: O[];
    clock: number;
    presence?: unknown;
  };

  // Response context (optional - may be partial if error occurs)
  res?: {
    operations?: O[];
    clock?: number;
    serializedDoc?: S;
  };

  // Processing details (optional - added as available)
  durationMs?: number;

  // Collaboration (optional - added when applicable)
  devicesCount?: number;
  clientsCount?: number;

  // Error context (only if error occurs)
  error?: {
    type: "AuthorizationError" | "DatabaseError" | "ValidationError";
    message: string;
    stack?: string;
  };
};

export type ClientConnectHandler<TContext = unknown> = (
  event: ClientConnectEvent<TContext>,
) => void;
export type ClientDisconnectHandler = (event: ClientDisconnectEvent) => void;
export type SyncRequestHandler<O = unknown, S = unknown> = (
  event: SyncRequestEvent<O, S>,
) => void;

// #endregion

// ============================================================================
// #region Client Types
// ============================================================================

/**
 * State for deferred operations (batching and debouncing).
 * Used to track pending timeouts and their associated data.
 */
export type DeferredState<T> = {
  timeout?: ReturnType<typeof setTimeout>;
  data: T;
};

export type Identity = {
  userId: string;
  secret: string;
};

/**
 * Arguments for {@link DocSyncClient["getDoc"]}.
 *
 * - `{ type, id }` → Try to get an existing doc by ID. Returns `undefined` if not found.
 * - `{ type, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
 * - `{ type, id, createIfMissing: true }` → Get existing doc or create it if not found.
 */
export type GetDocArgs =
  | { type: string; id: string; createIfMissing?: boolean }
  | { type: string; createIfMissing: true };

export type DocData<D> = { doc: D; docId: string };

/**
 * Presence is a record of user IDs to their presence data.
 * It is used to track the presence of users in a document.
 */
export type Presence<T = unknown> = Record<string, T>;

export type BroadcastMessage<O> =
  | {
      type: "OPERATIONS";
      operations: O;
      docId: string;
      presence?: Record<string, unknown>;
    }
  | { type: "PRESENCE"; docId: string; presence: Record<string, unknown> };

export type ClientConfig<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> = {
  docBinding: DocBinding<D, S, O>;
  server: {
    url: string;
    auth: {
      /**
       * Server authentication token.
       *
       * - Passed verbatim to the server on connection.
       * - Validation is delegated to the server via `onAuth`.
       * - This library does not issue, refresh, or rotate tokens.
       */
      getToken: () => Promise<string>;
    };
  };
  local: {
    // We want D, S, O to be inferred from the docBinding, not
    // from the provider
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: new (identity: Identity) => Provider<any, any, "client">;
    /**
     * Resolves the local storage identity.
     *
     * Used exclusively for:
     * - Namespacing local persistence (userId)
     * - Deriving encryption keys for data at rest (secret)
     *
     * About the secret:
     * - Must never be persisted client-side (localStorage, IndexedDB, etc).
     * - Re-encryption is not supported, so losing the secret makes local data permanently unrecoverable.
     *
     */
    getIdentity: () => Promise<Identity>;
  };
};

// #endregion

// ============================================================================
// #region Server Types
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
  provider: new () => Provider<NoInfer<S>, NoInfer<O>, "server">;

  /**
   * Authenticates a WebSocket connection.
   *
   * - Called once per connection attempt.
   * - Must validate the provided token.
   * - Must resolve the canonical userId.
   * - May optionally return a context object that will be passed to authorize.
   *
   * @returns User info with optional context, or undefined if authentication fails.
   */
  // method syntax is required to avoid type errors
  authenticate(ev: { token: string }): Promise<
    | {
        userId: string;
        context?: TContext;
      }
    | undefined
  >;

  /**
   * Authorizes an operation.
   *
   * - Called for each operation (get-doc, apply-operations, create-doc, save-doc).
   * - Receives the cached context from authenticate.
   * - Can use cached context for fast checks or fetch fresh data for consistency.
   *
   * @returns true to allow, false to deny.
   */
  authorize?(ev: {
    type: DocSyncEventName;
    payload: unknown;
    userId: string;
    context: TContext;
  }): Promise<boolean>;
};

// #endregion

// ============================================================================
// #region Provider Types
// ============================================================================

export type SerializedDocPayload<S> = {
  serializedDoc: S;
  docId: string;
  clock: number;
};

/**
 * Context passed to transaction callbacks.
 * All operations share the same underlying transaction.
 */
// prettier-ignore
export type TransactionContext<S, O, P extends "server" | "client"> = {
  getSerializedDoc(docId: string): Promise<{ serializedDoc: S; clock: number } | undefined>;
  getOperations(arg: P extends "server" ? { docId: string; clock: number } : { docId: string }): Promise<O[][]>;
  deleteOperations(arg: { docId: string; count: number }): Promise<void>;
  saveOperations(arg: { docId: string; operations: O[] }): Promise<P extends "server" ? number : void>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
  // TODO:   // getDocIdsChangedSince
};

/**
 * Storage provider for client or server.
 * All operations must be performed within a transaction.
 */
export type Provider<S, O, P extends "server" | "client"> = {
  /**
   * Run operations in a single atomic transaction.
   * If any operation fails, all changes are rolled back.
   */
  transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: TransactionContext<S, O, P>) => Promise<T>,
  ): Promise<T>;
};

// #endregion

// ============================================================================
// #region Socket.IO Types
// ============================================================================

/**
 * Socket.IO type definitions derived from DocSync events.
 */

type ClientToServerEvents<S, O> = {
  sync: SyncHandler<S, O>;
  presence: PresenceHandler;
  "delete-doc": DeleteDocHandler;
  "unsubscribe-doc": UnsubscribeDocHandler;
};

type ServerToClientEvents = {
  // Server notifies clients that a document has been modified
  dirty: (payload: { docId: string }) => void;
  // Server notifies clients about presence updates
  presence: (payload: { docId: string; presence: Presence }) => void;
};

export type ServerSocket<S, O> = import("socket.io").Server<
  ClientToServerEvents<S, O>,
  ServerToClientEvents
>;

/** Per-connection socket on the server (has .id, .join, .emit, .on, etc.). */
export type ServerConnectionSocket<S, O> = import("socket.io").Socket<
  ClientToServerEvents<S, O>,
  ServerToClientEvents
>;

export type ClientSocket<S, O> = import("socket.io-client").Socket<
  ServerToClientEvents,
  ClientToServerEvents<S, O>
>;

// #endregion
