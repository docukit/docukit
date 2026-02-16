/* eslint-disable @typescript-eslint/no-empty-object-type */
import { io } from "socket.io-client";
import type { DocBinding, Presence } from "../shared/types.js";
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
import { handleDirty } from "./handlers/serverInitiated/dirty.js";
import { handlePresence } from "./handlers/clientInitiated/presence.js";
import { handlePresence as handleServerPresence } from "./handlers/serverInitiated/presence.js";
import { handleSync } from "./handlers/clientInitiated/sync.js";
import { handleUnsubscribe } from "./handlers/clientInitiated/unsubscribe.js";
import { BCHelper } from "./utils/BCHelper.js";
import { getDeviceId } from "./utils/getDeviceId.js";
import { getOwnPresencePatch } from "./utils/getOwnPresencePatch.js";

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

  /** Typed as unknown so DocSyncClient remains covariant in O, S (assignable to DocSyncClient base). */
  protected _events = createClientEventEmitter();

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

      this._events.emit("docLoad", {
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
      // We don't trigger an initial sync here because argId is undefined;
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

          if (doc) {
            const refCount = this._docsCache.get(docId)?.refCount ?? 1;
            this._events.emit("docLoad", {
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
            void handleSync(this, docId);
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
    void handlePresence(this, { docId, presence });
  }

  private _setupChangeListener(doc: D, docId: string) {
    this._docBinding.onChange(doc, ({ operations }) => {
      if (this._shouldBroadcast) {
        void this.onLocalOperations({ docId, operations: [operations] });

        this._events.emit("change", {
          docId,
          origin: "local",
          operations: [operations],
        });

        // Defer BC send so Lexical can update selection first; then the presence we
        // include is the new cursor. Two frames so setPresence (from selection change) has run.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const presencePatch = getOwnPresencePatch(this, docId);
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
      this._events.emit("docUnload", {
        docId,
        refCount: cacheEntry.refCount,
      });
    } else {
      cacheEntry.refCount = 0;
      this._events.emit("docUnload", {
        docId,
        refCount: 0,
      });

      // Dispose when promise resolves
      const doc = await cacheEntry.promisedDoc;
      const currentEntry = this._docsCache.get(docId);
      if (currentEntry?.refCount === 0) {
        this._docsCache.delete(docId);
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
          void handleSync(this, docId);
        }
      })();
    }, this._batchDelay);
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
