import type { QueryClient } from "@tanstack/query-core";
import { createDoc, type CreateDocArgs } from "./mutations/createDoc.js";
import {
  setDocPresence,
  type SetDocPresenceArgs,
} from "./mutations/setDocPresence.js";
import { getDoc, type GetDocArgs } from "./queries/getDoc/getDoc.js";
import {
  docPresence,
  type DocPresenceArgs,
} from "./queries/presence/presence.js";
import {
  createClientEventEmitter,
  type ClientEventMap,
  type ClientEventName,
  type ClientEventEmitter,
} from "./utils/events.js";
import { setupQueryClient } from "./utils/setupQueryClient/setupQueryClient.js";
import type { ClientConfig } from "./types.js";

export type DocSync2ClientConfig<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> = ClientConfig<D, S, O> & { queryClient: QueryClient };

export class DocSync2Client<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> {
  protected _connected = false;
  protected _events: ClientEventEmitter<O, S> = createClientEventEmitter();

  readonly queries = {
    getDoc: (args: GetDocArgs) => getDoc(args),
    docPresence: (args: DocPresenceArgs) => docPresence(args),
  };

  readonly mutations = {
    createDoc: (args: CreateDocArgs) => createDoc(this, args),
    setDocPresence: (args: SetDocPresenceArgs) => setDocPresence(this, args),
  };

  constructor(public readonly config: DocSync2ClientConfig<D, S, O>) {
    setupQueryClient(this);
  }

  connect(): void {
    this._connected = true;
  }

  disconnect(): void {
    this._connected = false;
  }

  dispose(): void {
    // this._events.emit("dispose"); // Maybe needed in the future
    this.config.queryClient.removeQueries({ queryKey: ["docsync2"] });
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
