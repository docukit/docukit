import type {
  ClientToServerEvents,
  DocBinding,
  MaybePromise,
  ServerToClientEvents,
  SerializedDocPayload,
} from "../shared/types.js";

// ============================================================================
// Query / Doc
// ============================================================================

export type FetchStatus = "fetching" | "paused" | "idle";

export type QueryResult<D, E = Error> =
  | { status: "pending"; fetchStatus: FetchStatus; data?: never; error?: never }
  | { status: "success"; fetchStatus: FetchStatus; data: D; error?: never }
  | {
      status: "error";
      fetchStatus: FetchStatus;
      data?: D | undefined;
      error: E;
    };

/**
 * Arguments for {@link DocSyncClient["getDoc"]}.
 */
export type GetDocArgs = {
  type: string;
  id: string;
  createIfMissing?: boolean;
};

export type DocData<D> = { doc: D; docId: string };

// ============================================================================
// Client State & Config
// ============================================================================

export type DeferredState<T> = {
  timeout?: ReturnType<typeof setTimeout>;
  data: T;
};

export type Identity = { userId: string; secret: string };

export type TokenClientAuthConfig = {
  /**
   * Token authentication mode.
   */
  mode: "token";

  /**
   * Server authentication token.
   *
   * - Passed verbatim to the server on connection.
   * - Validation is delegated to the server via `authenticate`.
   * - This library does not issue, refresh, rotate, or persist tokens.
   *
   * `getToken` is expected to be a cheap read from existing auth state, not a
   * network login flow.
   *
   * @example
   * ```ts
   * auth: {
   *   mode: "token",
   *   getToken: async () => authStore.accessToken,
   * }
   * ```
   */
  getToken: () => MaybePromise<string>;
};

export type RequestClientAuthConfig = {
  /**
   * Request authentication mode.
   *
   * Use this when the server authenticates from the WebSocket handshake
   * request. In browser apps, this is the recommended mode for existing
   * HttpOnly session cookies because JavaScript does not need to read the
   * session secret.
   */
  mode: "request";
};

export type ClientAuthConfig = TokenClientAuthConfig | RequestClientAuthConfig;

export type ClientConfig<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> = {
  docBinding: DocBinding<D, S, O>;
  server: { url: string; auth: ClientAuthConfig };
  timing?: {
    /**
     * Maximum time to batch local operation updates while another user is
     * online in the same document, and presence updates that are visible to
     * local tabs or collaborators.
     *
     * Recommended values are between 33ms (30 fps, used in Figma) and 100ms
     * (10 fps) for a collaborative experience.
     *
     * @default 50
     */
    collabMaxDebounce?: number;
    /**
     * Maximum time to batch local operations when no other user is online in
     * the same document.
     *
     * Recommended values are between 1s and 10s.
     *
     * @default 3000
     */
    singleClientMaxDebounce?: number;
  };
  local: {
    provider: (identity: Identity) => ClientProvider<NoInfer<S>, NoInfer<O>>;
    getIdentity: () => MaybePromise<Identity>;
  };
};

// ============================================================================
// Client Provider
// ============================================================================

/**
 * Context passed to client transaction callbacks.
 * All operations share the same underlying transaction.
 */
export type ClientProviderContext<S extends object, O extends object> = {
  getSerializedDoc(arg: {
    docId: string;
  }): Promise<{ serializedDoc: S; clock: number } | undefined>;
  getOperations(arg: { docId: string }): Promise<O[][]>;
  deleteOperations(arg: { docId: string; count: number }): Promise<void>;
  saveOperations(arg: { docId: string; operations: O[] }): Promise<void>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
};

/**
 * Storage provider for the client.
 * All operations must be performed within a transaction.
 */
export type ClientProvider<S extends object, O extends object> = {
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
