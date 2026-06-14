import type { QueryClient } from "@tanstack/query-core";
import { io } from "socket.io-client";
import { createDoc, type CreateDocArgs } from "./mutations/createDoc.js";
import {
  setDocPresence,
  type SetDocPresenceArgs,
} from "./mutations/setDocPresence.js";
import { getDoc, type GetDocArgs } from "./queries/getDoc/getDoc.js";
import {
  getDocPresence,
  type DocPresenceArgs,
} from "./queries/getDocPresence/getDocPresence.js";
import {
  createClientEventEmitter,
  type ClientEventMap,
  type ClientEventName,
  type ClientEventEmitter,
} from "./utils/events.js";
import { handleConnect } from "./handlers/connection/connect.js";
import { handleDirty } from "./handlers/serverInitiated/dirty.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { getDeviceId } from "./utils/getDeviceId.js";
import { setupQueryClient } from "./utils/setupQueryClient/setupQueryClient.js";
import type { ClientConfig, ClientSocket, LocalResolved } from "./types.js";

export type DocSyncClientConfig<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> = ClientConfig<D, S, O> & { queryClient: QueryClient };

export class DocSyncClient<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> {
  protected _localPromise: Promise<LocalResolved<S, O>>;
  protected _socket: ClientSocket<S, O>;
  /** Client-generated id for presence (works offline; sent in auth so server uses same key) */
  protected _clientId = crypto.randomUUID();
  protected _deviceId = getDeviceId();
  protected _changeOrigin: "local" | "network" = "local";
  protected _events: ClientEventEmitter<O, S> = createClientEventEmitter();

  readonly queries = {
    getDoc: (args: GetDocArgs) => getDoc(this, args),
    getDocPresence: (args: DocPresenceArgs) => getDocPresence(args),
  };

  readonly mutations = {
    createDoc: (args: CreateDocArgs) => createDoc(this, args),
    setDocPresence: (args: SetDocPresenceArgs) => setDocPresence(this, args),
  };

  constructor(public readonly config: DocSyncClientConfig<D, S, O>) {
    this._localPromise = (async () => {
      const identity = await config.local.getIdentity();
      const provider = config.local.provider(identity);

      // this._bcHelper = new BCHelper(this, identity.userId);

      return { provider, identity };
    })();

    this._socket = io(config.server.url, {
      auth: (cb) => {
        void Promise.resolve(config.server.auth.getToken()).then((token) => {
          cb({ token, deviceId: this._deviceId, clientId: this._clientId });
        });
      },
      transports: ["websocket"],
    });

    setupQueryClient(this);
    handleConnect({ client: this });
    handleDisconnect({ client: this });
    handleDirty({ client: this });
  }

  connect(): void {
    this._socket.connect();
  }

  disconnect(): void {
    this._socket.disconnect();
  }

  dispose(): void {
    // this._events.emit("dispose"); // Maybe needed in the future
    this.config.queryClient.removeQueries({ queryKey: ["docsync"] });
    this.config.queryClient.unmount();
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
    return this._events.on(event, listener);
  }
}
