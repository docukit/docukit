import type {
  ClientToServerEvents,
  MaybePromise,
  Presence,
  ServerToClientEvents,
  SerializedDocPayload,
} from "../shared/types.js";
import type { Socket } from "socket.io-client";
import type { DocBinding } from "./bindings/types.js";

export type Identity = { userId: string; secret: string };

export type DeferredState<T> = {
  data: T;
  timeout?: ReturnType<typeof setTimeout>;
};

export type PresenceDebounceState = DeferredState<unknown> & {
  resolves: Set<() => void>;
  rejects: Set<(error: unknown) => void>;
};

export type PresenceState = {
  presence: Presence;
  listeners: Set<(presence: Presence) => void>;
};

export type ClientConfig<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> = {
  docBinding: DocBinding<D, S, O>;
  server: { url: string; auth: { getToken: () => MaybePromise<string> } };
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

export type LocalResolved<S extends object, O extends object> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};

export type ClientSocket<S extends object, O extends object> = Socket<
  ServerToClientEvents,
  ClientToServerEvents<S, O>
>;
