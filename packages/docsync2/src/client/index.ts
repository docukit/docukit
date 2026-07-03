import { QueryClient } from "@tanstack/query-core";
import { io } from "socket.io-client";
import {
  setDocPresence,
  type SetDocPresenceArgs,
} from "./mutations/setDocPresence.js";
import { getDoc, type GetDocArgs } from "./queries/getDoc/getDoc.js";
import { getDocPresence } from "./queries/getDocPresence/getDocPresence.js";
import {
  createClientEventEmitter,
  type ClientEventMap,
  type ClientEventName,
  type ChangeOrigin,
} from "./utils/events.js";
import { handleConnect } from "./handlers/connection/connect.js";
import { handleCollaboration } from "./handlers/serverInitiated/collaboration.js";
import { handleDirty } from "./handlers/serverInitiated/dirty.js";
import { handlePresence } from "./handlers/serverInitiated/presence.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handleIdentity } from "./handlers/serverInitiated/identity.js";
import { getDeviceId } from "./utils/getDeviceId.js";
import { setupQueryClient } from "./utils/setupQueryClient/setupQueryClient.js";
import type { BCHelper } from "./utils/BCHelper.js";
import {
  clearLocalIdentity as clearStoredLocalIdentity,
  readLocalIdentity,
} from "./utils/localIdentity.js";
import { setupLocalPromise } from "./utils/setupLocalPromise.js";
import type { DocBinding } from "./bindings/types.js";
import type {
  ClientConfig,
  ClientSocket,
  DeferredState,
  LocalResolved,
  PresenceDebounceState,
  PresenceState,
} from "./types.js";

type LocalOpsBatchState<O extends object> = DeferredState<O[]> & {
  startedAt: number;
};

export class DocSyncClient<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> {
  protected _docBinding: DocBinding<D, S, O>;
  protected _queryClient: QueryClient;
  protected _localPromise: Promise<LocalResolved<S, O>>;
  protected _deviceId = getDeviceId();
  // Client-generated id for presence (works offline; sent in auth so server uses same key)
  protected _clientId = crypto.randomUUID();
  protected _bcHelper?: BCHelper<D, S, O>;
  protected _socket: ClientSocket<S, O>;
  protected _changeOrigin: ChangeOrigin = "local";

  // Flow control state (batching, debouncing, push queueing)
  protected _localOpsBatchState = new Map<string, LocalOpsBatchState<O>>();
  protected _collabMaxDebounce: number;
  protected _singleClientMaxDebounce: number;
  protected _collabDocIds = new Set<string>();
  protected _presenceDebounceState = new Map<string, PresenceDebounceState>();
  protected _presenceStateByDocId = new Map<string, PresenceState>();

  /** Typed as unknown so DocSyncClient remains covariant in O, S (assignable to DocSyncClient base). */
  protected _events = createClientEventEmitter();

  readonly queries = {
    getDoc: (args: GetDocArgs) => getDoc(this, args),
    getDocPresence: getDocPresence(this),
  };

  readonly mutations = {
    setDocPresence: (args: SetDocPresenceArgs) => setDocPresence(this, args),
  };

  constructor(config: ClientConfig<D, S, O>) {
    const { docBinding, local, timing } = config;
    this._docBinding = docBinding;
    this._queryClient = new QueryClient();
    this._collabMaxDebounce = Math.max(0, timing?.collabMaxDebounce ?? 50);
    this._singleClientMaxDebounce = Math.max(
      0,
      timing?.singleClientMaxDebounce ?? 3000,
    );

    const cachedIdentity = readLocalIdentity();
    this._socket = io(config.server.url, {
      auth: (cb) => {
        const authPayload = {
          deviceId: this._deviceId,
          clientId: this._clientId,
          claimedUserId: cachedIdentity?.userId ?? null,
        };

        if (config.server.auth.mode === "request") {
          cb(authPayload);
          return;
        }

        void Promise.resolve(config.server.auth.getToken()).then((token) => {
          cb({ ...authPayload, token });
        });
      },
      withCredentials: config.server.auth.mode === "request",
      transports: ["websocket"],
    });
    this._localPromise = setupLocalPromise({
      client: this,
      providerFactory: local.provider,
      cachedIdentity,
    });

    setupQueryClient(this);
    handleIdentity({ client: this });
    handleConnect({ client: this });
    handleDisconnect({ client: this });
    handleCollaboration({ client: this });
    handleDirty({ client: this });
    handlePresence({ client: this });
  }

  connect(): void {
    this._socket.connect();
  }

  disconnect(): void {
    this._socket.disconnect();
  }

  clearLocalIdentity(): void {
    clearStoredLocalIdentity();
  }

  dispose(): void {
    // this._events.emit("dispose"); // Maybe needed in the future
    this._bcHelper?.close();
    this._queryClient.removeQueries({ queryKey: ["docsync"] });
    this._queryClient.unmount();
  }

  /**
   * Register a listener for an event. Returns an unsubscribe function.
   * Event payload type is inferred from the event name (first argument).
   * @example
   * const off = client.on("dispose", () => { ... });
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
