import type { SyncRequest, SyncResponse } from "../../shared/types.js";

// ============================================================================
// Event payload types
// ============================================================================

export type DisconnectEvent = { reason: string };

export type ChangeEvent<O = unknown> = {
  docId: string;
  origin: "local" | "broadcast" | "remote";
  operations: O[];
};

/** Emitted once after sync completes (success or error). */
export type SyncEvent<O = unknown, S = unknown> = { req: SyncRequest<O> } & (
  | SyncResponse<S, O>
  | { error: { type: "NetworkError"; message: string }; data?: never }
);

export type DocLoadEvent = {
  docId: string;
  source: "cache" | "local" | "created";
  refCount: number;
};

export type DocUnloadEvent = { docId: string; refCount: number };

// ============================================================================
// Event map and emitter
// ============================================================================

export type ClientEventMap<O = unknown, S = unknown> = {
  connect: undefined;
  disconnect: DisconnectEvent;
  change: ChangeEvent<O>;
  sync: SyncEvent<O, S>;
  docLoad: DocLoadEvent;
  docUnload: DocUnloadEvent;
};

export type ClientEventName = keyof ClientEventMap;

export type ClientEventEmitter<O = unknown, S = unknown> = {
  listeners: {
    [K in ClientEventName]: Set<(payload: ClientEventMap<O, S>[K]) => void>;
  };
  on<K extends ClientEventName>(
    event: K,
    cb: (payload: ClientEventMap<O, S>[K]) => void,
  ): () => void;
  emit<K extends ClientEventName>(
    event: K,
    payload?: ClientEventMap<O, S>[K],
  ): void;
};

export function createClientEventEmitter<
  O = unknown,
  S = unknown,
>(): ClientEventEmitter<O, S> {
  const listeners: {
    [K in ClientEventName]: Set<(payload: ClientEventMap<O, S>[K]) => void>;
  } = {
    connect: new Set(),
    disconnect: new Set(),
    change: new Set(),
    sync: new Set(),
    docLoad: new Set(),
    docUnload: new Set(),
  };

  function on<K extends ClientEventName>(
    event: K,
    cb: (payload: ClientEventMap<O, S>[K]) => void,
  ): () => void {
    const set = listeners[event];
    set.add(cb as (p: ClientEventMap<O, S>[ClientEventName]) => void);
    return () => {
      set.delete(cb as (p: ClientEventMap<O, S>[ClientEventName]) => void);
    };
  }

  function emit<K extends ClientEventName>(
    event: K,
    payload?: ClientEventMap<O, S>[K],
  ): void {
    const set = listeners[event];
    for (const fn of set) {
      (fn as (p: ClientEventMap<O, S>[K] | undefined) => void)(payload);
    }
  }

  return { listeners, on, emit };
}
