import type {
  ClientToServerEvents,
  DocBinding,
  Presence,
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
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handleDirty } from "./handlers/serverInitiated/dirty.js";
import { handlePresence } from "./handlers/clientInitiated/presence.js";
import { handlePresence as handleServerPresence } from "./handlers/serverInitiated/presence.js";
import { BCHelper } from "./utils/BCHelper.js";
import { deleteDocMethod } from "./methods/deleteDoc.js";
import { getDocMethod } from "./methods/getDoc/getDoc.js";
import { getPresenceMethod } from "./methods/getPresence.js";
import { createSocket } from "./utils/createSocket.js";

// TODO: review this type!
type LocalResolved<S, O> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};
export class DocSyncClient<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  protected _docBinding: DocBinding<D, S, O>;
  protected _docsCache = new Map<
    string,
    {
      promisedDoc: Promise<D | "deleted" | undefined>;
      refCount: number;
      presence: Presence;
      presenceListeners: Set<(presence: Presence) => void>;
      pushStatus: "idle" | "pushing" | "pushing-with-pending";
      localOpsBatchState: DeferredState<O[]>;
      presenceDebounceState: DeferredState<unknown>;
    }
  >();
  protected _localPromise: Promise<LocalResolved<S, O>>;
  /** Client-generated id for presence (works offline; sent in auth so server uses same key) */
  protected _clientId: string;
  private _shouldBroadcast = true;
  protected _bcHelper?: BCHelper<D, S, O>;
  protected _socket: ClientSocket<S, O>;

  // Flow control (batching, debouncing)
  protected _batchDelay = 50;
  protected _presenceDebounce = 200;

  /** Typed as unknown so DocSyncClient remains covariant in O, S (assignable to DocSyncClient base). */
  protected _events = createClientEventEmitter();

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const { docBinding, local } = config;
    this._docBinding = docBinding;
    this._clientId = crypto.randomUUID();

    // Initialize local provider
    this._localPromise = (async () => {
      const identity = await local.getIdentity();
      const provider = new local.provider(identity) as ClientProvider<S, O>;
      this._bcHelper = new BCHelper(this, identity.userId);
      return { provider, identity };
    })();

    this._socket = createSocket(this, config);

    handleConnect({ client: this });
    handleDisconnect({ client: this });
    handleDirty({ client: this });
    handleServerPresence({ client: this });
  }

  protected async _request<E extends keyof ClientToServerEvents<S, O>>(
    event: E,
    payload: Parameters<ClientToServerEvents<S, O>[E]>[0],
  ) {
    type Res = Parameters<Parameters<ClientToServerEvents<S, O>[E]>[1]>[0];
    let response: Res;
    try {
      const socket = this._socket;
      response = await (
        socket.emitWithAck as (e: E, p: typeof payload) => Promise<Res>
      )(event, payload);
    } catch (error) {
      response = {
        error: {
          type: "NetworkError",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return response;
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
    return getDocMethod(this, args, onChange);
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
    return getPresenceMethod(this, args, onChange);
  }

  async setPresence({ docId, presence }: { docId: string; presence: unknown }) {
    void handlePresence(this, { docId, presence });
  }

  /**
   * Delete a document: persist a local "deleted" marker (so it survives offline),
   * update cache, then either queue sync (offline) or send delete to server and clear ops on success.
   */
  deleteDoc({ docId }: { docId: string }): void {
    void deleteDocMethod(this, { docId });
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
