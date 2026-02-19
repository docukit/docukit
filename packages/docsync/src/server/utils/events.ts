import type {
  ClientConnectEvent,
  ClientDisconnectEvent,
  SyncRequestEvent,
} from "../types.js";

// ============================================================================
// Event map and emitter
// ============================================================================

export type ServerEventMap<TContext = unknown, O = unknown, S = unknown> = {
  clientConnect: ClientConnectEvent<TContext>;
  clientDisconnect: ClientDisconnectEvent;
  syncRequest: SyncRequestEvent<O, S>;
};

export type ServerEventName = keyof ServerEventMap;

export type ServerEventEmitter<TContext = unknown, O = unknown, S = unknown> = {
  listeners: {
    [K in ServerEventName]: Set<
      (payload: ServerEventMap<TContext, O, S>[K]) => void
    >;
  };
  on<K extends ServerEventName>(
    event: K,
    cb: (payload: ServerEventMap<TContext, O, S>[K]) => void,
  ): () => void;
  emit<K extends ServerEventName>(
    event: K,
    payload: ServerEventMap<TContext, O, S>[K],
  ): void;
};

export function createServerEventEmitter<
  TContext = unknown,
  O = unknown,
  S = unknown,
>(): ServerEventEmitter<TContext, O, S> {
  const listeners: {
    [K in ServerEventName]: Set<
      (payload: ServerEventMap<TContext, O, S>[K]) => void
    >;
  } = {
    clientConnect: new Set(),
    clientDisconnect: new Set(),
    syncRequest: new Set(),
  };

  function on<K extends ServerEventName>(
    event: K,
    cb: (payload: ServerEventMap<TContext, O, S>[K]) => void,
  ): () => void {
    const set = listeners[event];
    set.add(cb as (p: ServerEventMap<TContext, O, S>[ServerEventName]) => void);
    return () => {
      set.delete(
        cb as (p: ServerEventMap<TContext, O, S>[ServerEventName]) => void,
      );
    };
  }

  function emit<K extends ServerEventName>(
    event: K,
    payload: ServerEventMap<TContext, O, S>[K],
  ): void {
    const set = listeners[event];
    for (const fn of set) {
      (fn as (p: ServerEventMap<TContext, O, S>[K]) => void)(payload);
    }
  }

  return { listeners, on, emit };
}
