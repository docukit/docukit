/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  ClientToServerEvents,
  DocBinding,
  ServerToClientEvents,
  SerializedDocPayload,
  SyncRequest,
  SyncResponse,
} from "../shared/types.js";

// ============================================================================
// Query / Doc
// ============================================================================

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

/**
 * Arguments for {@link DocSyncClient["getDoc"]}.
 */
export type GetDocArgs =
  | { type: string; id: string; createIfMissing?: boolean }
  | { type: string; createIfMissing: true };

export type DocData<D> = { doc: D; docId: string };

// ============================================================================
// Client Events
// ============================================================================

export type DisconnectEvent = {
  reason: string;
};

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

export type DocLoadEvent = {
  docId: string;
  source: "cache" | "local" | "created";
  refCount: number;
};

export type DocUnloadEvent = {
  docId: string;
  refCount: number;
};

export type ConnectEventListener = () => void;
export type DisconnectEventListener = (event: DisconnectEvent) => void;
// eslint-disable-next-line @typescript-eslint/prefer-function-type
export type ChangeEventListener<O = {}> = { (event: ChangeEvent<O>): void };
/** Client listener for when a sync completes (passed to {@link DocSyncClient.onSync}). */
// eslint-disable-next-line @typescript-eslint/prefer-function-type
export type SyncEventListener<O = {}> = { (event: SyncEvent<O>): void };
export type DocLoadEventListener = (event: DocLoadEvent) => void;
export type DocUnloadEventListener = (event: DocUnloadEvent) => void;

// ============================================================================
// Client State & Config
// ============================================================================

export type DeferredState<T> = {
  timeout?: ReturnType<typeof setTimeout>;
  data: T;
};

export type Identity = {
  userId: string;
  secret: string;
};

export type ClientConfig<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> = {
  docBinding: DocBinding<D, S, O>;
  server: {
    url: string;
    auth: {
      getToken: () => Promise<string>;
    };
  };
  local: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: new (identity: Identity) => ClientProvider<any, any>;
    getIdentity: () => Promise<Identity>;
  };
};

// ============================================================================
// Client Provider
// ============================================================================

/**
 * Context passed to client transaction callbacks.
 * All operations share the same underlying transaction.
 */
export type ClientProviderContext<S, O> = {
  getSerializedDoc(
    docId: string,
  ): Promise<{ serializedDoc: S; clock: number } | undefined>;
  getOperations(arg: { docId: string }): Promise<O[][]>;
  deleteOperations(arg: { docId: string; count: number }): Promise<void>;
  saveOperations(arg: { docId: string; operations: O[] }): Promise<void>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
};

/**
 * Storage provider for the client.
 * All operations must be performed within a transaction.
 */
export type ClientProvider<S, O> = {
  transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: ClientProviderContext<S, O>) => Promise<T>,
  ): Promise<T>;
};

// ============================================================================
// Socket (client)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- type-only reference to socket.io-client
export type ClientSocket<S, O> = import("socket.io-client").Socket<
  ServerToClientEvents,
  ClientToServerEvents<S, O>
>;
