import type { SyncRequest, SyncResponse } from "../../shared/types.js";

export type DisconnectEvent = { reason: string };

export type ChangeOrigin = "local" | "network" | "local-broadcast";

export type ChangeEvent<O = unknown> = {
  docId: string;
  origin: ChangeOrigin;
  operation: O;
};

export type SyncEvent<O = unknown, S = unknown> = {
  req: SyncRequest<S, O>;
  attempt: number;
} & (
  | SyncResponse<S, O>
  | { error: { type: "NetworkError"; message: string }; data?: never }
);

export type ClientEventMap<
  O extends object = object,
  S extends object = object,
> = {
  connect: undefined;
  disconnect: DisconnectEvent;
  change: ChangeEvent<O>;
  sync: SyncEvent<O, S>;
};

export type ClientEventName = keyof ClientEventMap;

export type ClientEventEmitter<
  O extends object = object,
  S extends object = object,
> = {
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
  O extends object = object,
  S extends object = object,
>(): ClientEventEmitter<O, S> {
  const listeners: {
    [K in ClientEventName]: Set<(payload: ClientEventMap<O, S>[K]) => void>;
  } = {
    connect: new Set(),
    disconnect: new Set(),
    change: new Set(),
    sync: new Set(),
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
