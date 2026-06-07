export type ClientEventMap<
  _O extends object = object,
  _S extends object = object,
> = { todo: undefined };

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
  } = { todo: new Set() };

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
