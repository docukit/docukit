/* eslint-disable @typescript-eslint/no-empty-object-type */
import { io } from "socket.io-client";
import type { DocBinding } from "../shared/docBinding.js";
import type {
  BroadcastMessage,
  ClientConfig,
  Provider,
  DocData,
  GetDocArgs,
  Identity,
  QueryResult,
  ConnectHandler,
  DisconnectHandler,
  ChangeHandler,
  SyncHandler,
  DocLoadHandler,
  DocUnloadHandler,
  ClientSocket,
  DocSyncEventName,
  DocSyncEvents,
  Presence,
} from "../shared/types.js";

// TODO: review this type!
type LocalResolved<S, O> = {
  provider: Provider<S, O, "client">;
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
      presenceHandlers: Set<(presence: Presence) => void>;
    }
  >();
  protected _localPromise: Promise<LocalResolved<S, O>>;
  protected _deviceId: string;
  private _shouldBroadcast = true;
  protected _broadcastChannel?: BroadcastChannel;
  protected _socket: ClientSocket<S, O>;
  protected _pushStatusByDocId = new Map<string, PushStatus>();
  protected _localOpsThrottleState = new Map<
    string,
    { timeout?: ReturnType<typeof setTimeout>; queue: O[] }
  >();
  protected _throttle = 50;
  protected _presenceDebounceState = new Map<
    string,
    { timeout: ReturnType<typeof setTimeout>; pendingValue: unknown }
  >();
  protected _presenceDebounce = 50;

  // Event handlers - ChangeHandler and SyncHandler use default (unknown) to allow covariance
  protected _connectHandlers = new Set<ConnectHandler>();
  protected _disconnectHandlers = new Set<DisconnectHandler>();
  protected _changeHandlers = new Set<ChangeHandler>();
  protected _syncHandlers = new Set<SyncHandler>();
  protected _docLoadHandlers = new Set<DocLoadHandler>();
  protected _docUnloadHandlers = new Set<DocUnloadHandler>();

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const { docBinding, local } = config;
    this._docBinding = docBinding;

    // Initialize local provider (if configured)
    this._localPromise = (async () => {
      const identity = await local.getIdentity();
      const provider = new local.provider(identity) as Provider<S, O, "client">;

      // Initialize BroadcastChannel with user-specific channel name
      // This ensures only tabs of the same user share operations
      this._broadcastChannel = new BroadcastChannel(
        `docsync:${identity.userId}`,
      );
      this._broadcastChannel.onmessage = async (
        ev: MessageEvent<BroadcastMessage<O>>,
      ) => {
        // RECEIVED MESSAGES
        if (ev.data.type === "OPERATIONS") {
          // Another tab is pushing operations - they are responsible for pushing to server
          // We just need to coordinate push status to avoid conflicts
          const currentStatus =
            this._pushStatusByDocId.get(ev.data.docId) ?? "idle";

          if (currentStatus === "pushing") {
            // Mark as busy to avoid concurrent pushes
            this._pushStatusByDocId.set(ev.data.docId, "pushing-with-pending");
          }
          // Note: We don't call saveRemote here - the sender is responsible for pushing
          // If the sender is offline, the push will happen when they reconnect

          void this._applyOperations(ev.data.operations, ev.data.docId);
          return;
        }
      };

      return { provider, identity };
    })();

    this._deviceId = getDeviceId();
    this._socket = io(config.server.url, {
      auth: (cb) => {
        void config.server.auth.getToken().then((token) => {
          cb({ token, deviceId: this._deviceId });
        });
      },
      // Performance optimizations for testing
      transports: ["websocket"], // Skip polling, go straight to WebSocket
    });

    this._socket.on("connect", () => {
      // Emit connect event
      this._emit(this._connectHandlers);
      // Push pending operations for all loaded docs
      for (const docId of this._docsCache.keys()) {
        this.saveRemote({ docId });
      }
    });
    this._socket.on("disconnect", (reason) => {
      this._pushStatusByDocId.clear();
      this._emit(this._disconnectHandlers, { reason });
    });
    this._socket.on("connect_error", (err) => {
      this._emit(this._disconnectHandlers, { reason: err.message });
    });

    // Listen for dirty notifications from server
    this._socket.on("dirty", (payload) => {
      this.saveRemote({ docId: payload.docId });
    });
    this._socket.on("presence", (payload) => {
      const cacheEntry = this._docsCache.get(payload.docId);
      if (!cacheEntry) return;

      // Update cached presence with the patch from server
      // Handle null/undefined values as deletions
      const newPresence = { ...cacheEntry.presence };
      for (const [key, value] of Object.entries(payload.presence)) {
        if (value === undefined || value === null) {
          delete newPresence[key];
        } else {
          newPresence[key] = value;
        }
      }
      cacheEntry.presence = newPresence;

      // Notify all registered handlers with FULL presence state
      cacheEntry.presenceHandlers.forEach((handler) =>
        handler(cacheEntry.presence),
      );
    });
  }

  connect() {
    this._socket.connect();
  }

  disconnect() {
    this._socket.disconnect();
  }

  async _applyOperations(operations: O, docId: string) {
    const docFromCache = this._docsCache.get(docId);
    if (!docFromCache) return;
    const doc = await docFromCache.promisedDoc;
    if (!doc) return;
    this._shouldBroadcast = false;
    this._docBinding.applyOperations(doc, operations);
    this._shouldBroadcast = true;

    // Emit change event for broadcast operations
    this._emit(this._changeHandlers, {
      docId,
      origin: "broadcast",
      operations: [operations],
    });
  }

  // TODO: used when server responds with a new doc (squashing)
  async _replaceDocInCache({
    docId,
    doc,
    serializedDoc,
  }: {
    docId: string;
    doc?: D;
    serializedDoc?: S;
  }) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;

    // Deserialize if needed
    const newDoc = doc ?? this._docBinding.deserialize(serializedDoc!);

    // Replace the cached document with the new one
    // Keep the same refCount
    // Note: We don't setup a new change listener here because:
    // 1. The doc already has all operations applied from the sync
    // 2. A listener will be setup when the doc is loaded via getDoc
    // 3. Multiple listeners would cause operations to be applied multiple times
    this._docsCache.set(docId, {
      promisedDoc: Promise.resolve(newDoc),
      refCount: cacheEntry.refCount,
      presence: cacheEntry.presence,
      presenceHandlers: cacheEntry.presenceHandlers,
    });
  }

  async _applyServerOperations({
    docId,
    operations,
  }: {
    docId: string;
    operations: O[];
  }) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;

    // Get the cached document and apply server operations to it
    const doc = await cacheEntry.promisedDoc;
    if (!doc) return;

    this._shouldBroadcast = false;
    for (const op of operations) {
      this._docBinding.applyOperations(doc, op);
    }
    this._shouldBroadcast = true;

    // Emit change event for remote operations
    this._emit(this._changeHandlers, {
      docId,
      origin: "remote",
      operations,
    });
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
   * 2. `{ status: "success", data: { doc, id } }` - Document loaded successfully
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
      const { doc, id } = this._docBinding.create(type);
      docId = id;
      this._docsCache.set(id, {
        promisedDoc: Promise.resolve(doc),
        refCount: 1,
        presence: {},
        presenceHandlers: new Set(),
      });
      this._setupChangeListener(doc, id);
      emit({ status: "success", data: { doc, id } });

      // Emit doc load event
      this._emit(this._docLoadHandlers, {
        docId: id,
        source: "created",
        refCount: 1,
      });

      void (async () => {
        const local = await this._localPromise;
        if (!local) return;
        await local.provider.transaction("readwrite", (ctx) =>
          ctx.saveSerializedDoc({
            serializedDoc: this._docBinding.serialize(doc),
            docId: id,
            clock: 0,
          }),
        );
      })();
      // We don't trigger a initial saveRemote here because argId is undefined,
      // so this is truly a new doc. Initial operations will be pushed to server
      return () => void this._unloadDoc(id);
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
          presenceHandlers: new Set(),
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
            this._emit(this._docLoadHandlers, {
              docId,
              source,
              refCount,
            });
          }

          emit({
            status: "success",
            data: doc ? { doc, id: docId } : undefined,
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
   * Multiple handlers can be registered for the same document.
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

    // Add handler to the set
    cacheEntry.presenceHandlers.add(onChange);

    // Immediately call with current presence if available
    if (Object.keys(cacheEntry.presence).length > 0) {
      onChange(cacheEntry.presence);
    }

    // Return unsubscribe function that removes only this handler
    return () => {
      const entry = this._docsCache.get(docId);
      if (entry) {
        entry.presenceHandlers.delete(onChange);
      }
    };
  }

  async setPresence({ docId, presence }: { docId: string; presence: unknown }) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry)
      throw new Error(`Doc ${docId} is not loaded, cannot set presence`);

    // Clear existing timeout if any
    const existingState = this._presenceDebounceState.get(docId);
    if (existingState) {
      clearTimeout(existingState.timeout);
    }

    // Debounce the presence update
    const timeout = setTimeout(() => {
      const state = this._presenceDebounceState.get(docId);
      if (!state) return;

      this._presenceDebounceState.delete(docId);

      // Note: We send raw presence data. Server will use socket.id as the key.
      // We do NOT update local cache here - server broadcasts only to others.
      void (async () => {
        const { error } = await this._request("presence", {
          docId,
          presence: state.pendingValue,
        });
        if (error) {
          console.error(`Error setting presence for doc ${docId}:`, error);
        }
      })();
    }, this._presenceDebounce);

    this._presenceDebounceState.set(docId, { timeout, pendingValue: presence });
  }

  private _setupChangeListener(doc: D, docId: string) {
    this._docBinding.onChange(doc, ({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({ type: "OPERATIONS", operations, docId });
        void this.onLocalOperations({ docId, operations: [operations] });

        // Emit change event for local operations
        this._emit(this._changeHandlers, {
          docId,
          origin: "local",
          operations: [operations],
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
      this._emit(this._docUnloadHandlers, {
        docId,
        refCount: cacheEntry.refCount,
      });
    } else {
      // Mark refCount as 0 but keep in cache until promise resolves
      cacheEntry.refCount = 0;

      // Emit immediately
      this._emit(this._docUnloadHandlers, {
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

  _sendMessage(message: BroadcastMessage<O>) {
    this._broadcastChannel?.postMessage(message);
  }

  onLocalOperations({ docId, operations }: { docId: string; operations: O[] }) {
    // Get or create the throttle state for this document
    let state = this._localOpsThrottleState.get(docId);

    if (!state) {
      // Create new state with empty queue
      state = { queue: [] };
      this._localOpsThrottleState.set(docId, state);
    }

    // Add operations to queue
    if (operations.length > 0) {
      state.queue.push(...operations);
    }

    // If there is already a pending timeout, we just wait
    if (state.timeout !== undefined) {
      return;
    }

    // Otherwise, schedule the save
    state.timeout = setTimeout(() => {
      void (async () => {
        const currentState = this._localOpsThrottleState.get(docId);
        if (!currentState) return;

        const opsToSave = currentState.queue;
        this._localOpsThrottleState.delete(docId);

        if (opsToSave && opsToSave.length > 0) {
          const local = await this._localPromise;
          await local?.provider.transaction("readwrite", (ctx) =>
            ctx.saveOperations({ docId, operations: opsToSave }),
          );
          this.saveRemote({ docId });
        }
      })();
    }, this._throttle);
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
    // Skip if socket is not connected (e.g., in local-only mode or during tests)
    if (!this._socket.connected) return;
    try {
      await this._request("unsubscribe-doc", { docId });
    } catch {
      // Silently ignore errors during cleanup (e.g., socket
      // disconnected during request, timeout, or server error)
    }
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

    let response;
    try {
      response = await this._request("sync-operations", {
        clock: clientClock,
        docId,
        operations,
      });
    } catch (error) {
      // Emit sync event (network error)
      this._emit(this._syncHandlers, {
        req: {
          docId,
          operations,
          clock: clientClock,
        },
        error: {
          type: "NetworkError",
          message: error instanceof Error ? error.message : String(error),
        },
      });

      // Retry on failure
      this._pushStatusByDocId.set(docId, "idle");
      void this._doPush({ docId });
      return;
    }

    // Check if server returned an error
    if ("error" in response && response.error) {
      // Emit sync event with server error
      this._emit(this._syncHandlers, {
        req: {
          docId,
          operations,
          clock: clientClock,
        },
        error: response.error,
      });

      // Retry on error
      this._pushStatusByDocId.set(docId, "idle");
      void this._doPush({ docId });
      return;
    }

    // At this point, response must have data
    const { data } = response;

    // Emit sync event (success)
    this._emit(this._syncHandlers, {
      req: {
        docId,
        operations,
        clock: clientClock,
      },
      data: {
        ...(data.operations ? { operations: data.operations } : {}),
        ...(data.serializedDoc ? { serializedDoc: data.serializedDoc } : {}),
        clock: data.clock,
      },
    });

    // Atomically: delete synced operations + consolidate into serialized doc
    let didConsolidate = false; // Track if we actually saved new operations to IDB
    await provider.transaction("readwrite", async (ctx) => {
      // Delete client operations that were synced (delete batches, not individual ops)
      if (operationsBatches.length > 0) {
        await ctx.deleteOperations({
          docId,
          count: operationsBatches.length,
        });
      }

      // Consolidate operations into serialized doc
      const stored = await ctx.getSerializedDoc(docId);
      if (!stored) return;

      // Skip consolidation if another client (same IDB) already updated to this clock
      // This handles the case where another tab/client already wrote this update
      if (stored.clock >= data.clock) {
        didConsolidate = false;
        return;
      }

      // Collect all operations to apply: server ops first, then client ops
      const serverOps = data.operations ?? [];
      const allOps = [...serverOps, ...operations];

      // Only proceed if there are operations to apply
      if (allOps.length > 0) {
        const doc = this._docBinding.deserialize(stored.serializedDoc);

        // Apply all operations in order (server ops first, then client ops)
        for (const op of allOps) {
          this._docBinding.applyOperations(doc, op);
        }
        const serializedDoc = this._docBinding.serialize(doc);

        // Before saving, verify clock hasn't changed (another concurrent write)
        // This prevents race conditions when multiple tabs/clients share the same IDB
        const recheckStored = await ctx.getSerializedDoc(docId);
        if (!recheckStored || recheckStored?.clock !== stored.clock) {
          // Clock changed during our transaction - another client beat us
          // Silently skip to avoid duplicate operations
          return;
        }

        await ctx.saveSerializedDoc({
          serializedDoc,
          docId,
          clock: data.clock, // Use clock from server
        });
        didConsolidate = true; // Mark that we successfully saved
      }
    });

    // CRITICAL: Only apply serverOps to memory if we actually saved to IDB
    // If we skipped (clock already up-to-date), operations are already in memory via BC
    if (didConsolidate && data.operations && data.operations.length > 0) {
      // Apply to our own memory
      void this._applyServerOperations({
        docId,
        operations: data.operations,
      });

      // Broadcast server operations to other tabs so they can apply them too
      for (const op of data.operations) {
        this._sendMessage({ type: "OPERATIONS", operations: op, docId });
      }
    }

    // Status may have changed to "pushing-with-pending" during async ops
    const currentStatus = this._pushStatusByDocId.get(docId);
    const shouldRetry = currentStatus === "pushing-with-pending";
    if (shouldRetry) {
      // Keep status as "pushing" and retry immediately to avoid race window
      // where a dirty event could trigger another concurrent _doPush
      void this._doPush({ docId });
    } else {
      this._pushStatusByDocId.set(docId, "idle");
    }
  }

  protected async _request<E extends DocSyncEventName>(
    event: E,
    payload: DocSyncEvents<S, O>[E]["request"],
  ): Promise<DocSyncEvents<S, O>[E]["response"]> {
    type Emit = <K extends DocSyncEventName>(
      event: K,
      payload: DocSyncEvents<S, O>[K]["request"],
      cb: (res: DocSyncEvents<S, O>[K]["response"]) => void,
    ) => void;

    // TO-DO: should I reject on disconnect?
    return new Promise((resolve, reject) => {
      // Add a timeout to prevent hanging forever if socket disconnects during request
      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout: ${event}`));
      }, 5000); // 5 second timeout

      (this._socket.emit as Emit)(event, payload, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  // ============================================================================
  // Event Registration Methods
  // ============================================================================

  /**
   * Register a handler for connection events.
   * @returns Unsubscribe function
   */
  onConnect(handler: ConnectHandler): () => void {
    this._connectHandlers.add(handler);
    return () => {
      this._connectHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for disconnection events.
   * @returns Unsubscribe function
   */
  onDisconnect(handler: DisconnectHandler): () => void {
    this._disconnectHandlers.add(handler);
    return () => {
      this._disconnectHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for document change events.
   * @returns Unsubscribe function
   */
  onChange(handler: ChangeHandler<O>): () => void {
    const h = handler as ChangeHandler;
    this._changeHandlers.add(h);
    return () => {
      this._changeHandlers.delete(h);
    };
  }

  /**
   * Register a handler for sync events.
   * @returns Unsubscribe function
   */
  onSync(handler: SyncHandler<O>): () => void {
    const h = handler as SyncHandler;
    this._syncHandlers.add(h);
    return () => {
      this._syncHandlers.delete(h);
    };
  }

  /**
   * Register a handler for document load events.
   * @returns Unsubscribe function
   */
  onDocLoad(handler: DocLoadHandler): () => void {
    this._docLoadHandlers.add(handler);
    return () => {
      this._docLoadHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for document unload events.
   * @returns Unsubscribe function
   */
  onDocUnload(handler: DocUnloadHandler): () => void {
    this._docUnloadHandlers.add(handler);
    return () => {
      this._docUnloadHandlers.delete(handler);
    };
  }

  // ============================================================================
  // Event Emitters (protected methods)
  // ============================================================================

  protected _emit(handlers: Set<() => void>): void;
  protected _emit<T>(handlers: Set<(event: T) => void>, event: T): void;
  protected _emit<T>(handlers: Set<(event?: T) => void>, event?: T) {
    for (const handler of handlers) {
      if (event !== undefined) {
        handler(event);
      } else {
        handler();
      }
    }
  }
}

/**
 * Get or create a unique device ID stored in localStorage.
 * This ID is shared across all tabs/windows on the same device.
 */
function getDeviceId(): string {
  const key = "docsync:deviceId";
  let deviceId = localStorage.getItem(key);
  if (!deviceId) {
    // Generate a new device ID using crypto.randomUUID()
    deviceId = crypto.randomUUID();
    localStorage.setItem(key, deviceId);
  }
  return deviceId;
}
