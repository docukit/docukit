import { io } from "socket.io-client";
import type {
  DocBinding,
  Presence,
  TransactionFlags,
} from "../shared/types.js";
import type {
  ClientConfig,
  ClientProvider,
  ClientSocket,
  DeferredState,
  DocData,
  GetDocArgs,
  Identity,
  QueryResult,
} from "./types.js";
import type { ClientEventMap, ClientEventName } from "./utils/events.js";
import { createClientEventEmitter } from "./utils/events.js";
import { handleConnect } from "./handlers/connection/connect.js";
import { handleDeleteDoc } from "./handlers/clientInitiated/deleteDoc.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handleCollaboration } from "./handlers/serverInitiated/collaboration.js";
import { handleDirty } from "./handlers/serverInitiated/dirty.js";
import { handlePresence as handleServerPresence } from "./handlers/serverInitiated/presence.js";
import { handleSync } from "./handlers/clientInitiated/sync/sync.js";
import { handleUnsubscribe } from "./handlers/clientInitiated/unsubscribe.js";
import type { BCHelper } from "./utils/BCHelper.js";
import {
  dispatchAllDocQueriesConnected,
  dispatchAllDocQueriesDisconnected,
  dispatchLocalDocFound,
  dispatchLocalQueryError,
} from "./utils/dispatchDocQueryAction.js";
import {
  clearLocalIdentity as clearStoredLocalIdentity,
  readLocalMetadata,
} from "./utils/localIdentity.js";
import { setupDocChangeListener } from "./utils/setupDocChangeListener.js";
import { pauseQueries } from "./utils/pauseQueries.js";
import { setupLocalPromise } from "./utils/setupLocalPromise.js";
import { clearSyncRetry, type SyncRetryState } from "./utils/syncRetry.js";
import { DocSyncError } from "./utils/DocSyncError.js";

// TODO: review this type!
type LocalResolved<S extends object, O extends object> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};

type LocalOpsBatchState<O extends object> = DeferredState<O[]> & {
  startedAt: number;
};

type SyncDebounceState = {
  timeout?: ReturnType<typeof setTimeout>;
  startedAt: number;
};

/**
 * A sync in flight. `rerun` records that another sync was asked for meanwhile;
 * `token` is what the attempt was started for, so a request for a reloaded
 * document or a new connection starts its own attempt instead of waiting on
 * one that can no longer report.
 */
type SyncQueueSlot = {
  rerun: boolean;
  token: { generation: number; cacheEntry: object };
  controller: AbortController;
};
type ChangeOrigin = "local" | "network" | "local-broadcast";
type LocalLoadMode = "load" | "loadOrCreate";
type QueryListener = (result: QueryResult<DocData<object> | undefined>) => void;
type DocCacheEntry<D> = {
  promisedDoc: Promise<D | undefined>;
  refCount: number;
  localVersion: number;
  type: string;
  localLoadMode?: LocalLoadMode;
  queryResult: QueryResult<DocData<D> | undefined>;
  queryListeners: Set<QueryListener>;
  presence: Presence;
  presenceListeners: Set<(presence: Presence) => void>;
};

const LOCAL_IDB_MAX_DEBOUNCE = 50;

export class DocSyncCore<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> {
  protected _docBinding: DocBinding<D, S, O>;
  protected _docsCache = new Map<string, DocCacheEntry<D>>();
  protected _localPromise: Promise<LocalResolved<S, O>>;
  /** Client-generated id for presence (works offline; sent in auth so server uses same key) */
  protected _clientId: string;
  protected _bcHelper?: BCHelper<D, S, O>;
  protected _socket: ClientSocket<S, O>;
  protected _connectionError: Error | undefined;
  protected _connectionAttempt?: symbol;
  /**
   * Single source of truth for the network state new subscriptions start from.
   * Reading it off the socket at subscription time would report `fetching` to a
   * query created right after a failed connection attempt, while every query
   * created before it sits on `paused`.
   */
  protected _connectionFetchStatus: "fetching" | "paused";
  protected _changeOrigin: ChangeOrigin = "local";

  // Flow control state (batching, debouncing, push queueing)
  protected _localOpsBatchState = new Map<string, LocalOpsBatchState<O>>();
  protected _localWrites = new Map<string, Promise<void>>();
  protected _syncDebounceState = new Map<string, SyncDebounceState>();
  protected _collabMaxDebounce: number;
  protected _singleClientMaxDebounce: number;
  protected _collabDocIds = new Set<string>();
  protected _presenceDebounceState = new Map<string, DeferredState<unknown>>();
  /** Documents with a sync in flight, at most one attempt per document. */
  protected _syncQueue = new Map<string, SyncQueueSlot>();
  /**
   * Bumped on every disconnect. A sync attempt remembers the generation it
   * started on and goes silent once it changes, so an ack that arrives after
   * a reconnect cannot touch state that a newer attempt owns.
   */
  protected _connectionGeneration = 0;
  protected _syncRetryState = new Map<string, SyncRetryState>();

  /** Typed as unknown so DocSyncCore remains covariant in O, S (assignable to DocSyncCore base). */
  protected _events = createClientEventEmitter();

  constructor(config: ClientConfig<D, S, O>) {
    const { docBinding, local } = config;
    this._docBinding = docBinding;
    this._clientId = crypto.randomUUID();
    const { timing } = config;
    this._collabMaxDebounce = Math.max(0, timing?.collabMaxDebounce ?? 50);
    this._singleClientMaxDebounce = Math.max(
      0,
      timing?.singleClientMaxDebounce ?? 3000,
    );

    const metadata = readLocalMetadata();
    this._socket = io(config.server.url, {
      auth: (cb) => {
        const connectionAttempt = Symbol();
        this._connectionAttempt = connectionAttempt;
        const auth = config.server.auth;

        void metadata
          .then(async ({ deviceId, identity }) => {
            if (this._connectionAttempt !== connectionAttempt) return;
            const authPayload = {
              deviceId,
              clientId: this._clientId,
              claimedUserId: identity?.userId ?? null,
            };
            if (auth.mode === "request") {
              cb(authPayload);
              return;
            }
            const token = await auth.getToken();
            if (this._connectionAttempt !== connectionAttempt) return;
            cb({ ...authPayload, token });
          })
          .catch((error: unknown) => {
            if (this._connectionAttempt !== connectionAttempt) return;
            delete this._connectionAttempt;
            const connectionError = new DocSyncError(
              "ConnectionError",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
            this._socket.disconnect();
            pauseQueries(this, connectionError);
            this._events.emit("disconnect", {
              reason: connectionError.message,
            });
          });
      },
      withCredentials: config.server.auth.mode === "request",
      // Performance optimizations for testing
      transports: ["websocket"], // Skip polling, go straight to WebSocket
    });

    this._connectionFetchStatus = this._socket.active ? "fetching" : "paused";

    this._localPromise = setupLocalPromise({
      client: this,
      providerFactory: local.provider,
      cachedIdentity: metadata.then(({ identity }) => identity),
    });

    // Queries surface local initialization failures, even when no socket identity arrives.
    void this._localPromise.catch(() => {
      // Handled by each document query when it awaits local initialization.
    });

    handleConnect({ client: this });
    handleDisconnect({ client: this });
    handleCollaboration({ client: this });
    handleDirty({ client: this });
    handleServerPresence({ client: this });
  }

  connect() {
    if (this._socket.connected) return;

    // Keep the last connection error visible while recovery is only an
    // attempt. The successful `connect` event clears the client-wide error;
    // each loaded query clears its own error after its sync succeeds.
    // Loaded queries have to follow, or a document subscribed before the
    // reconnect would report `paused` while one subscribed after it reports
    // `fetching`, for the same client and the same socket.
    this._socket.connect();
    this._connectionFetchStatus = "fetching";
    dispatchAllDocQueriesConnected(this);
  }

  disconnect() {
    const wasConnected = this._socket.connected;
    delete this._connectionAttempt;
    this._socket.disconnect();
    this._connectionFetchStatus = "paused";
    // `_connectionError` is deliberately left in place. Disconnecting on
    // purpose adds no error, but it does not undo one either: if the previous
    // connection was rejected permanently, that rejection is still the last
    // thing that happened, and hiding it here would make a query created after
    // this call report a clean `pending` while every query loaded before it
    // still reports the error. Only a successful `connect` clears it.
    // Socket.IO only emits "disconnect" for a socket that had connected.
    // Disconnecting mid-handshake would otherwise leave every query on
    // "fetching" forever, because no listener ever runs.
    if (!wasConnected) {
      dispatchAllDocQueriesDisconnected(this);
    }
  }

  clearLocalIdentity() {
    return clearStoredLocalIdentity();
  }

  protected _initialQueryResult(): QueryResult<DocData<D> | undefined> {
    const fetchStatus = this._connectionFetchStatus;
    return this._connectionError
      ? { status: "error", fetchStatus, error: this._connectionError }
      : { status: "pending", fetchStatus };
  }

  /**
   * Keep a document loaded and receive its local/network state directly.
   * The callback receives the current state synchronously, then each change.
   * This reports loading/sync state; observe doc.onChange for content edits.
   * Release the subscription when the document is no longer needed.
   */
  subscribeDoc<T extends GetDocArgs>(
    args: T,
    onChange: (
      result: QueryResult<
        T extends { createIfMissing: true }
          ? DocData<D>
          : DocData<D> | undefined
      >,
    ) => void,
  ): () => void {
    const type = args.type;
    const docId = args.id;
    const createIfMissing =
      "createIfMissing" in args && args.createIfMissing === true;
    const localLoadMode = createIfMissing ? "loadOrCreate" : "load";
    const listener: QueryListener = (result) =>
      onChange(
        result as QueryResult<
          T extends { createIfMissing: true }
            ? DocData<D>
            : DocData<D> | undefined
        >,
      );
    let subscribed = true;
    const release = () => {
      if (!subscribed) return;
      subscribed = false;
      this._docsCache.get(docId)?.queryListeners.delete(listener);
      void this._unloadDoc(docId);
    };

    const existingCacheEntry = this._docsCache.get(docId);
    if (existingCacheEntry) {
      existingCacheEntry.refCount += 1;
      existingCacheEntry.queryListeners.add(listener);

      // Deliberately not gated on `status === "success"`: a query can hold data
      // together with a later error, and treating that as "no document" would
      // reload the doc and swap out the live instance the caller is editing.
      const hasDoc = existingCacheEntry.queryResult.data !== undefined;

      if (
        createIfMissing &&
        existingCacheEntry.localLoadMode !== "loadOrCreate" &&
        !hasDoc
      ) {
        existingCacheEntry.localLoadMode = "loadOrCreate";
        const promisedDoc = this._loadOrCreateDoc(docId, type);
        existingCacheEntry.promisedDoc = promisedDoc;
        this._observePromisedDoc(docId, promisedDoc, "loadOrCreate");
      }
    } else {
      // Create cache entry immediately so getPresence can subscribe
      const promisedDoc = this._loadOrCreateDoc(
        docId,
        createIfMissing ? type : undefined,
      );
      const queryResult = this._initialQueryResult();
      this._docsCache.set(docId, {
        promisedDoc,
        refCount: 1,
        localVersion: 0,
        type,
        localLoadMode,
        queryResult,
        queryListeners: new Set([listener]),
        presence: {},
        presenceListeners: new Set(),
      });
      this._observePromisedDoc(docId, promisedDoc, localLoadMode);
    }

    try {
      listener(this._docsCache.get(docId)!.queryResult);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  protected _emitQueryResult(
    docId: string,
    result: QueryResult<DocData<D> | undefined>,
  ): void {
    this._emitQueryResults([{ docId, result }]);
  }

  protected _emitQueryResults(
    updates: ReadonlyArray<{
      docId: string;
      result: QueryResult<DocData<D> | undefined>;
    }>,
  ): void {
    const notifications: Array<{
      listeners: QueryListener[];
      result: QueryResult<DocData<D> | undefined>;
    }> = [];

    // Commit every snapshot before calling user code. A listener that reads a
    // different document must never see a half-applied connection transition.
    for (const { docId, result } of updates) {
      const cacheEntry = this._docsCache.get(docId);
      if (!cacheEntry || result === cacheEntry.queryResult) continue;
      cacheEntry.queryResult = result;
      notifications.push({ listeners: [...cacheEntry.queryListeners], result });
    }

    let firstError: { value: unknown } | undefined;
    for (const { listeners, result } of notifications) {
      for (const listener of listeners) {
        try {
          listener(result);
        } catch (error: unknown) {
          firstError ??= { value: error };
        }
      }
    }
    if (firstError) throw firstError.value;
  }

  private _observePromisedDoc(
    docId: string,
    promisedDoc: Promise<D | undefined>,
    localLoadMode: LocalLoadMode,
  ): void {
    void (async () => {
      try {
        const doc = await promisedDoc;
        const cacheEntry = this._docsCache.get(docId);
        if (!cacheEntry) return;
        if (cacheEntry.promisedDoc !== promisedDoc) return;
        delete cacheEntry.localLoadMode;

        if (doc) {
          setupDocChangeListener(this, { doc, docId });
          this._events.emit("docLoad", {
            docId,
            source: localLoadMode === "loadOrCreate" ? "created" : "local",
            refCount: cacheEntry.refCount,
          });
        }

        if (doc) {
          dispatchLocalDocFound(this, docId, { doc, docId });
        }

        if (this._socket.connected) {
          void handleSync(this, docId);
        }
      } catch (e) {
        const cacheEntry = this._docsCache.get(docId);
        if (!cacheEntry) return;
        if (cacheEntry.promisedDoc !== promisedDoc) return;
        delete cacheEntry.localLoadMode;

        const error = e instanceof Error ? e : new Error(String(e));
        dispatchLocalQueryError(this, docId, error);
      }
    })();
  }

  protected _applyOperationsFrom(
    origin: Exclude<ChangeOrigin, "local">,
    doc: D,
    operations: O,
    flags?: TransactionFlags,
  ): void {
    this._changeOrigin = origin;
    try {
      this._docBinding.applyOperations(doc, operations, flags);
    } finally {
      this._changeOrigin = "local";
    }
  }

  private async _loadOrCreateDoc(
    docId: string,
    type?: string,
  ): Promise<D | undefined> {
    const local = await this._localPromise;
    if (!local) return undefined;

    return local.provider.transaction("readwrite", async (ctx) => {
      // Try to load existing doc
      const stored = await ctx.getSerializedDoc({ docId });
      const localOperations = await ctx.getOperations({ docId });

      if (stored) {
        const doc = this._docBinding.deserialize(stored.serializedDoc);
        localOperations.forEach((operationsBatch) => {
          operationsBatch.forEach((operations) => {
            this._docBinding.applyOperations(doc, operations, {
              skipUndo: true,
            });
          });
        });
        return doc;
      }

      // Create new doc if type provided
      if (type) {
        const { doc } = this._docBinding.create(type, docId);
        if (localOperations.length)
          throw new Error(
            `Doc ${docId} has operations stored locally but no serialized doc found`,
          );
        // Save the new doc to IDB
        await ctx.saveSerializedDoc({
          serializedDoc: this._docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        return doc;
      }

      return undefined;
    });
  }

  /**
   * Decrease the reference count of a document and, if it is 0, delete the document from the cache.
   */
  protected async _unloadDoc(docId: string) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;
    if (cacheEntry.refCount > 1) {
      cacheEntry.refCount -= 1;
      this._events.emit("docUnload", { docId, refCount: cacheEntry.refCount });
    } else {
      cacheEntry.refCount = 0;
      this._events.emit("docUnload", { docId, refCount: 0 });

      // Dispose when promise resolves
      // Loading errors are already reported through query state. Releasing a
      // failed load must still remove its subscription and cache entry.
      const doc = await cacheEntry.promisedDoc.catch(() => undefined);
      const currentEntry = this._docsCache.get(docId);
      if (currentEntry?.refCount === 0) {
        this._syncQueue.get(docId)?.controller.abort();
        this._docsCache.delete(docId);
        const syncState = this._syncDebounceState.get(docId);
        clearTimeout(syncState?.timeout);
        this._syncDebounceState.delete(docId);
        const presenceState = this._presenceDebounceState.get(docId);
        clearTimeout(presenceState?.timeout);
        this._presenceDebounceState.delete(docId);
        this._collabDocIds.delete(docId);
        clearSyncRetry(this, docId);
        if (doc) {
          await handleUnsubscribe(this._socket, { docId });
          this._docBinding.dispose(doc);
        }
      }
    }
  }

  onLocalOperations({ docId, operations }: { docId: string; operations: O[] }) {
    // Get or create the batch state for this document
    let state = this._localOpsBatchState.get(docId);
    const now = Date.now();
    const syncMaxDebounce = this._collabDocIds.has(docId)
      ? this._collabMaxDebounce
      : this._singleClientMaxDebounce;

    if (!state) {
      // Create new state with empty queue
      state = { data: [], startedAt: now };
      this._localOpsBatchState.set(docId, state);
    }

    // Add operations to queue
    if (operations.length > 0) {
      state.data.push(...operations);
    }

    if (now - state.startedAt >= LOCAL_IDB_MAX_DEBOUNCE) {
      void this._flushLocalOperations(docId, { sync: false });
    } else {
      state.timeout ??= setTimeout(
        () => {
          void this._flushLocalOperations(docId, { sync: false });
        },
        LOCAL_IDB_MAX_DEBOUNCE - (now - state.startedAt),
      );
    }

    this._debounceSync(docId, syncMaxDebounce, now);
  }

  protected _debounceSync(
    docId: string,
    maxDebounce: number,
    now: number,
  ): void {
    let state = this._syncDebounceState.get(docId);

    if (!state) {
      state = { startedAt: now };
      this._syncDebounceState.set(docId, state);
    }

    if (maxDebounce === 0 || now - state.startedAt >= maxDebounce) {
      void handleSync(this, docId);
      return;
    }

    if (state.timeout !== undefined) return;

    state.timeout = setTimeout(
      () => {
        void handleSync(this, docId);
      },
      maxDebounce - (now - state.startedAt),
    );
  }

  protected _sync(docId: string) {
    return handleSync(this, docId);
  }

  /**
   * Persist delivered local operations, including writes already in flight.
   * Finish the editor's transaction before calling this. This does not wait
   * for the network, so a document can be closed while offline.
   */
  async flush(docId: string) {
    await this._flushLocalOperations(docId, { sync: false });
    await this._localWrites.get(docId);
  }

  protected async _flushLocalOperations(
    docId: string,
    options?: { sync?: boolean },
  ): Promise<boolean> {
    const currentState = this._localOpsBatchState.get(docId);
    if (!currentState) return false;

    const opsToSave = currentState.data;
    clearTimeout(currentState.timeout);
    this._localOpsBatchState.delete(docId);

    if (opsToSave.length > 0) {
      const previous = this._localWrites.get(docId);
      const write = (async () => {
        await previous;
        const local = await this._localPromise;
        await local.provider.transaction("readwrite", (ctx) =>
          ctx.saveOperations({ docId, operations: opsToSave }),
        );
      })();
      this._localWrites.set(docId, write);
      try {
        await write;
      } finally {
        if (this._localWrites.get(docId) === write)
          this._localWrites.delete(docId);
      }
      if (options?.sync !== false) void handleSync(this, docId);
      return true;
    }
    return false;
  }

  protected async _deleteDoc(docId: string): Promise<boolean> {
    return handleDeleteDoc(this._socket, { docId });
  }

  /**
   * Register a listener for an event. Returns an unsubscribe function.
   * Event payload type is inferred from the event name (first argument).
   * @example
   * const off = client.on("connect", () => { ... });
   * client.on("docUnload", (ev) => { ... }); // ev is DocUnloadEvent
   * off(); // unsubscribe
   */
  on<K extends ClientEventName>(
    event: K,
    listener: (payload: ClientEventMap<O, S>[K]) => void,
  ): () => void {
    return this._events.on(
      event,
      listener as (payload: ClientEventMap<unknown, unknown>[K]) => void,
    );
  }
}
