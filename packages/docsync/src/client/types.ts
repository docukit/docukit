/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type { SerializedDocPayload } from "../shared/types.js";

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

export type DocData<D> = { doc: D; id: string };

export type QueryResult<D> =
  | {
      status: "loading";
      data: undefined;
      error: undefined;
    }
  | {
      status: "success";
      data: D;
      error: undefined;
    }
  | {
      status: "error";
      data: undefined;
      error: Error;
    };

export type BroadcastMessage<O> = {
  type: "OPERATIONS";
  operations: O;
  docId: string;
};

/**
 * Identity used for local persistence.
 *
 * - `userId`: Used to namespace the IndexedDB database (one DB per user).
 * - `secret`: Used to derive encryption keys for data at rest (future).
 */
export type Identity = {
  userId: string;
  secret: string;
};

export type ClientConfig<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> = {
  docBinding: DocBinding<D, S, O>;
  /**
   * If it is `true` and there is an open connection to the server,
   * clients will receive real-time updates from other clients.
   *
   * When `false`, changes from other users require a page refresh or
   * manual sync operation to be seen.
   *
   * @default true
   */
  realTime?: boolean;
  /**
   * If it is `true`, tabs and windows within the same device will
   * synchronize in real-time using BroadcastChannel API.
   *
   * This enables instant synchronization between tabs of the same
   * browser, even when offline or without a server connection.
   *
   * When `false`, each tab operates independently and changes are
   * only synchronized through the server or local storage.
   *
   * @default true
   */
  broadcastChannel?: boolean;
  server?: {
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
  local?: {
    // We want D, S, O to be inferred from the docBinding, not
    // from the provider
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: new (identity: Identity) => ClientProvider<any, any>;
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

/**
 * Context passed to transaction callbacks.
 * All operations share the same underlying transaction.
 */
// prettier-ignore
export type TransactionContext<S, O> = {
  getSerializedDoc(docId: string): Promise<{ serializedDoc: S; clock: number } | undefined>;
  getOperations({ docId }: { docId: string }): Promise<O[]>;
  deleteOperations(arg: { docId: string; count: number }): Promise<void>;
  saveOperations(arg: { docId: string; operations: O[] }): Promise<void>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
  // TODO:   // getDocIdsChangedSince
};

/**
 * Client-side storage provider.
 * All operations must be performed within a transaction.
 */
export type ClientProvider<S, O> = {
  /**
   * Run operations in a single atomic transaction.
   * If any operation fails, all changes are rolled back.
   */
  transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: TransactionContext<S, O>) => Promise<T>,
  ): Promise<T>;
};
