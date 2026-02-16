/* eslint-disable @typescript-eslint/no-empty-object-type */
import { io } from "socket.io-client";
import type { DocBinding, Presence } from "../shared/types.js";
import type {
  ClientConfig,
  ClientProvider,
  ClientSocket,
  ConnectEventListener,
  DeferredState,
  ChangeEventListener,
  DocData,
  DocLoadEventListener,
  DocUnloadEventListener,
  DisconnectEventListener,
  GetDocArgs,
  Identity,
  QueryResult,
  SyncEventListener,
} from "./types.js";
import { handleConnect } from "./handlers/connection/connect.js";
import { handleDeleteDoc } from "./handlers/clientInitiated/deleteDoc.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handleDirty } from "./handlers/serverInitiated/dirty.js";
import { handlePresence as sendPresence } from "./handlers/clientInitiated/presence.js";
import { handlePresence as handleServerPresence } from "./handlers/serverInitiated/presence.js";
import { handleSync } from "./handlers/clientInitiated/sync.js";
import { handleUnsubscribe } from "./handlers/clientInitiated/unsubscribe.js";
import { applyPresencePatch } from "./utils/applyPresencePatch.js";
import { BCHelper } from "./utils/BCHelper.js";
import { getDeviceId } from "./utils/getDeviceId.js";

// TODO: review this type!
type LocalResolved<S, O> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};

type PushStatus = "idle" | "pushing" | "pushing-with-pending";

export class DocSyncClient<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  protected _docBinding: DocBinding<D, S, O>;
  protected _docsCache = new Map<
    string,
    {
      promisedDoc: Promise<D | undefined>;
      refCount: number;
      presence: Presence;
      presenceListeners: Set<(presence: Presence) => void>;
    }
  >();
  protected _localPromise: Promise<LocalResolved<S, O>>;
  protected _deviceId: string;
  /** Client-generated id for presence (works offline; sent in auth so server uses same key) */
  protected _clientId: string;
  private _shouldBroadcast = true;
  protected _bcHelper?: BCHelper<D, S, O>;
  protected _socket: ClientSocket<S, O>;

  // Flow control state (batching, debouncing, push queueing)
  protected _localOpsBatchState = new Map<string, DeferredState<O[]>>();
  protected _batchDelay = 50;
  protected _presenceDebounceState = new Map<string, DeferredState<unknown>>();
  protected _presenceDebounce = 200;
  protected _pushStatusByDocId = new Map<string, PushStatus>();

  // Event listeners - ChangeEventListener and SyncEventListener use default (unknown) to allow covariance
  protected _connectEventListeners = new Set<ConnectEventListener>();
  protected _disconnectEventListeners = new Set<DisconnectEventListener>();
  protected _changeEventListeners = new Set<ChangeEventListener>();
  protected _syncEventListeners = new Set<SyncEventListener>();
  protected _docLoadEventListeners = new Set<DocLoadEventListener>();
  protected _docUnloadEventListeners = new Set<DocUnloadEventListener>();

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const { docBinding, local } = config;
    this._docBinding = docBinding;
    this._clientId = crypto.randomUUID();

    // Initialize local provider (if configured)
    this._localPromise = (async () => {
      const identity = await local.getIdentity();
      const provider = new local.provider(identity) as ClientProvider<S, O>;

      this._bcHelper = new BCHelper(this, identity.userId);

      return { provider, identity };
    })();

    this._deviceId = getDeviceId();
    this._socket = io(config.server.url, {
      auth: (cb) => {
        void config.server.auth.getToken().then((token) => {
          cb({ token, deviceId: this._deviceId, clientId: this._clientId });
        });
      },
      // Performance optimizations for testing
      transports: ["websocket"], // Skip polling, go straight to WebSocket
    });

    handleConnect({ client: this });
    handleDisconnect({ client: this });
    handleDirty({ client: this });
    handleServerPresence({ client: this });
  }

  connect() {
    this._socket.connect();
  }

  disconnect() {
    this._socket.disconnect();
  }

  /** Current presence for this client (debounce state or cache); does not clear the timer */
  private _getOwnPresencePatch(
    docId: string,
  ): Record<string, unknown> | undefined {
    const debounced = this._presenceDebounceState.get(docId);
    if (debounced) return { [this._clientId]: debounced.data };
    const cacheEntry = this._docsCache.get(docId);
    if (cacheEntry?.presence[this._clientId] !== undefined)
      return { [this._clientId]: cacheEntry.presence[this._clientId] };
    return undefined;
  }

  /**
   * Subscribe to a document with reactive state updates.
   *
   * The behavior depends on which fields are provided:
   * - `{ type, id }` → Try to get an existing doc. Returns `undefined` if not found.
   * - `{ type, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
   * - `{ type, id, createIfMissing: true }` → Get existing doc or create it if not found.
   *
   * The callback will be invoked with state updates:
   * 1. `{ status: "loading" }` - Initial state while fetching
   * 2. `{ status: "success", data: { doc, docId } }` - Document loaded successfully
   * 3. `{ status: "error", error }` - Failed to load document
   *
   * To observe document content changes, use `doc.onChange()` directly on the returned doc.
   *
   * @example
   * ```ts
   * const unsubscribe = client.getDoc(
   *   { type: "notes", id: "abc123" },
   *   (result) => {
   *     if (result.status === "loading") console.log("Loading...");
   *     if (result.status === "success") console.log("Doc:", result.data.doc);
   *     if (result.status === "error") console.error(result.error);
   *   }
   * );
   *
   * // Clean up when done
   * unsubscribe();
   * ```
   */
  getDoc<T extends GetDocArgs>(
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
    const argId = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    // Internal emit uses wider type; runtime logic ensures correct data per overload
    const emit = onChange as (
      result: QueryResult<DocData<D> | undefined>,
    ) => void;
    let docId: string | undefined;

    // Case: { type, createIfMissing: true } → Create new doc with auto-generated ID (sync).
    if (!argId && createIfMissing) {
      const { doc, docId: createdDocId } = this._docBinding.create(type);
      docId = createdDocId;
      this._docsCache.set(createdDocId, {
        promisedDoc: Promise.resolve(doc),
        refCount: 1,
        presence: {},
        presenceListeners: new Set(),
      });
      this._setupChangeListener(doc, createdDocId);
      emit({ status: "success", data: { doc, docId: createdDocId } });

      // Emit doc load event
      this._emit(this._docLoadEventListeners, {
        docId: createdDocId,
        source: "created",
        refCount: 1,
      });

      void (async () => {
        const local = await this._localPromise;
        if (!local) return;
        await local.provider.transaction("readwrite", (ctx) =>
          ctx.saveSerializedDoc({
            serializedDoc: this._docBinding.serialize(doc),
            docId: createdDocId,
            clock: 0,
          }),
        );
      })();
      // We don't trigger a initial saveRemote here because argId is undefined,
      // so this is truly a new doc. Initial operations will be pushed to server
      return () => void this._unloadDoc(createdDocId);
    }

    // Preparing for the async cases
    emit({ status: "loading" });

    // Case: { type, id } or { type, id, createIfMissing } → Load or create (async).
    if (argId) {
      docId = argId;
      // Check cache BEFORE async block to avoid race conditions with getPresence
      const existingCacheEntry = this._docsCache.get(docId);
      if (existingCacheEntry) {
        existingCacheEntry.refCount += 1;
      } else {
        // Create cache entry immediately so getPresence can subscribe
        const promisedDoc = this._loadOrCreateDoc(
          docId,
          createIfMissing ? type : undefined,
        );
        this._docsCache.set(docId, {
          promisedDoc,
          refCount: 1,
          presence: {},
          presenceListeners: new Set(),
        });
      }

      void (async () => {
        try {
          let doc: D | undefined;
          let source: "cache" | "local" | "created" = "local";
          const cacheEntry = this._docsCache.get(docId)!;
          if (existingCacheEntry) {
            doc = await cacheEntry.promisedDoc;
            source = "cache";
          } else {
            doc = await cacheEntry.promisedDoc;
            if (doc) {
              // Register listener only for new docs (not cache hits)
              this._setupChangeListener(doc, docId);
              source = createIfMissing ? "created" : "local";
            }
          }

          // Emit doc load event
          if (doc) {
            const refCount = this._docsCache.get(docId)?.refCount ?? 1;
            this._emit(this._docLoadEventListeners, {
              docId,
              source,
              refCount,
            });
          }

          emit({
            status: "success",
            data: doc ? { doc, docId } : undefined,
          });
          // Fetch from server to check if document exists there
          if (doc) {
            void this.saveRemote({ docId });
          }
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          emit({ status: "error", error });
        }
      })();
    }

    return () => {
      if (docId) void this._unloadDoc(docId);
    };
  }

  /**
   * Subscribe to presence updates for a document.
   * Multiple listeners can be registered for the same document.
   * @param args - The arguments for the getPresence request.
   * @param onChange - The callback to invoke when the presence changes.
   * @returns A function to unsubscribe from presence updates.
   */
  getPresence(
    args: { docId: string | undefined },
    onChange: (presence: Presence) => void,
  ): () => void {
    const { docId } = args;
    if (!docId) return () => void undefined;
    const cacheEntry = this._docsCache.get(docId);

    if (!cacheEntry) {
      throw new Error(
        `Cannot subscribe to presence for document "${docId}" - document not loaded.`,
      );
    }

    // Add listener to the set
    cacheEntry.presenceListeners.add(onChange);

    // Immediately call with current presence if available
    if (Object.keys(cacheEntry.presence).length > 0) {
      onChange(cacheEntry.presence);
    }

    // Return unsubscribe function that removes only this listener
    return () => {
      const entry = this._docsCache.get(docId);
      if (entry) {
        entry.presenceListeners.delete(onChange);
      }
    };
  }

  async setPresence({ docId, presence }: { docId: string; presence: unknown }) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry)
      throw new Error(`Doc ${docId} is not loaded, cannot set presence`);

    // Clear existing timeout if any
    const existingState = this._presenceDebounceState.get(docId);
    clearTimeout(existingState?.timeout);

    // Debounce the presence update
    const timeout = setTimeout(() => {
      const state = this._presenceDebounceState.get(docId);
      if (!state) return;

      this._presenceDebounceState.delete(docId);

      const patch = { [this._clientId]: state.data };

      // Update local cache and notify listeners (so own cursor shows and UI stays in sync)
      applyPresencePatch(this._clientId, cacheEntry, patch);

      // Same device: broadcast to other tabs (works offline)
      this._bcHelper?.broadcast({
        type: "PRESENCE",
        docId,
        presence: patch,
      });
      // Other devices: send via WebSocket only when connected
      void sendPresence({
        socket: this._socket,
        docId,
        presence: state.data,
      });
    }, this._presenceDebounce);

    this._presenceDebounceState.set(docId, { timeout, data: presence });
  }

  private _setupChangeListener(doc: D, docId: string) {
    this._docBinding.onChange(doc, ({ operations }) => {
      if (this._shouldBroadcast) {
        void this.onLocalOperations({ docId, operations: [operations] });

        this._emit(this._changeEventListeners, {
          docId,
          origin: "local",
          operations: [operations],
        });

        // Defer BC send so Lexical can update selection first; then the presence we
        // include is the new cursor. Two frames so setPresence (from selection change) has run.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const presencePatch = this._getOwnPresencePatch(docId);
            this._bcHelper?.broadcast({
              type: "OPERATIONS",
              operations,
              docId,
              ...(presencePatch && { presence: presencePatch }),
            });
          });
        });
      }
      // Don't automatically reset _shouldBroadcast here!
      // Let the caller explicitly control when to re-enable broadcasting
    });
  }

  private async _loadOrCreateDoc(
    docId: string,
    type?: string,
  ): Promise<D | undefined> {
    const local = await this._localPromise;
    if (!local) return undefined;

    return local.provider.transaction("readwrite", async (ctx) => {
      // Try to load existing doc
      const stored = await ctx.getSerializedDoc(docId);
      const localOperations = await ctx.getOperations({ docId });

      if (stored) {
        const doc = this._docBinding.deserialize(stored.serializedDoc);
        this._shouldBroadcast = false;
        localOperations.forEach((operationsBatch) => {
          operationsBatch.forEach((operations) => {
            this._docBinding.applyOperations(doc, operations);
          });
        });
        this._shouldBroadcast = true;
        return doc;
      }

      // Create new doc if type provided
      if (type) {
        const { doc } = this._docBinding.create(type, docId);
        this._shouldBroadcast = false;
        if (localOperations.length)
          throw new Error(
            `Doc ${docId} has operations stored locally but no serialized doc found`,
          );
        this._shouldBroadcast = true;
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
      this._emit(this._docUnloadEventListeners, {
        docId,
        refCount: cacheEntry.refCount,
      });
    } else {
      // Mark refCount as 0 but keep in cache until promise resolves
      cacheEntry.refCount = 0;

      // Emit immediately
      this._emit(this._docUnloadEventListeners, {
        docId,
        refCount: 0,
      });

      // Dispose when promise resolves
      const doc = await cacheEntry.promisedDoc;
      const currentEntry = this._docsCache.get(docId);
      if (currentEntry?.refCount === 0) {
        this._docsCache.delete(docId);
        if (doc) {
          await this.unsubscribeDoc(docId);
          this._docBinding.dispose(doc);
        }
      }
    }
  }

  onLocalOperations({ docId, operations }: { docId: string; operations: O[] }) {
    // Get or create the batch state for this document
    let state = this._localOpsBatchState.get(docId);

    if (!state) {
      // Create new state with empty queue
      state = { data: [] };
      this._localOpsBatchState.set(docId, state);
    }

    // Add operations to queue
    if (operations.length > 0) {
      state.data.push(...operations);
    }

    // If there is already a pending timeout, we just wait
    if (state.timeout !== undefined) {
      return;
    }

    // Otherwise, schedule the batch save
    state.timeout = setTimeout(() => {
      void (async () => {
        const currentState = this._localOpsBatchState.get(docId);
        if (!currentState) return;

        const opsToSave = currentState.data;
        this._localOpsBatchState.delete(docId);

        if (opsToSave && opsToSave.length > 0) {
          const local = await this._localPromise;
          await local?.provider.transaction("readwrite", (ctx) =>
            ctx.saveOperations({ docId, operations: opsToSave }),
          );
          this.saveRemote({ docId });
        }
      })();
    }, this._batchDelay);
  }

  /**
   * Push local operations to the server for a specific document.
   * Uses a per-docId queue to prevent concurrent pushes for the same doc.
   */
  saveRemote({ docId }: { docId: string }) {
    const status = this._pushStatusByDocId.get(docId) ?? "idle";
    if (status !== "idle") {
      this._pushStatusByDocId.set(docId, "pushing-with-pending");
      return;
    }
    void this._doPush({ docId });
  }

  /**
   * Unsubscribe from real-time updates for a document.
   * Should be called when a document is unloaded (refCount 1 → 0).
   */
  async unsubscribeDoc(docId: string): Promise<void> {
    await handleUnsubscribe(this._socket, { docId });
  }

  protected async _doPush({ docId }: { docId: string }) {
    this._pushStatusByDocId.set(docId, "pushing");
    const provider = (await this._localPromise).provider;

    // Get the current clock value and operations from provider
    const [operationsBatches, stored] = await provider.transaction(
      "readonly",
      async (ctx) => {
        return Promise.all([
          ctx.getOperations({ docId }),
          ctx.getSerializedDoc(docId),
        ]);
      },
    );
    const operations = operationsBatches.flat();
    const clientClock = stored?.clock ?? 0;

    const presenceState = this._presenceDebounceState.get(docId);
    if (presenceState) {
      clearTimeout(presenceState.timeout);
      this._presenceDebounceState.delete(docId);
      this._bcHelper?.broadcast({
        type: "PRESENCE",
        docId,
        presence: { [this._clientId]: presenceState.data },
      });
    }

    await handleSync({
      client: this,
      operationsBatches,
      operations,
      docId,
      clientClock,
      ...(presenceState ? { presence: presenceState.data } : {}),
    });
  }

  protected async _deleteDoc(docId: string): Promise<boolean> {
    return handleDeleteDoc(this._socket, { docId });
  }

  // ============================================================================
  // Event Registration Methods
  // ============================================================================

  /**
   * Register a listener for connection events.
   * @returns Unsubscribe function
   */
  onConnect(listener: ConnectEventListener): () => void {
    this._connectEventListeners.add(listener);
    return () => {
      this._connectEventListeners.delete(listener);
    };
  }

  /**
   * Register a listener for disconnection events.
   * @returns Unsubscribe function
   */
  onDisconnect(listener: DisconnectEventListener): () => void {
    this._disconnectEventListeners.add(listener);
    return () => {
      this._disconnectEventListeners.delete(listener);
    };
  }

  /**
   * Register a listener for document change events.
   * @returns Unsubscribe function
   */
  onChange(listener: ChangeEventListener<O>): () => void {
    const h = listener as ChangeEventListener;
    this._changeEventListeners.add(h);
    return () => {
      this._changeEventListeners.delete(h);
    };
  }

  /**
   * Register a listener for sync completion events.
   * @returns Unsubscribe function
   */
  onSync(listener: SyncEventListener<O>): () => void {
    const h = listener as SyncEventListener;
    this._syncEventListeners.add(h);
    return () => {
      this._syncEventListeners.delete(h);
    };
  }

  /**
   * Register a listener for document load events.
   * @returns Unsubscribe function
   */
  onDocLoad(listener: DocLoadEventListener): () => void {
    this._docLoadEventListeners.add(listener);
    return () => {
      this._docLoadEventListeners.delete(listener);
    };
  }

  /**
   * Register a listener for document unload events.
   * @returns Unsubscribe function
   */
  onDocUnload(listener: DocUnloadEventListener): () => void {
    this._docUnloadEventListeners.add(listener);
    return () => {
      this._docUnloadEventListeners.delete(listener);
    };
  }

  // ============================================================================
  // Event Emitters (protected methods)
  // ============================================================================

  protected _emit(listeners: Set<() => void>): void;
  protected _emit<T>(listeners: Set<(event: T) => void>, event: T): void;
  protected _emit<T>(listeners: Set<(event?: T) => void>, event?: T) {
    for (const listener of listeners) {
      if (event !== undefined) {
        listener(event);
      } else {
        listener();
      }
    }
  }
}
