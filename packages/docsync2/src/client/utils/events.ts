import type { NonNullableValue } from "../../shared/types.js";

export type ClientEventMap<
  _O extends NonNullableValue = NonNullableValue,
  _S extends NonNullableValue = NonNullableValue,
> = { dispose: undefined };

export type ClientEventName = keyof ClientEventMap;

export type ClientEventEmitter<
  O extends NonNullableValue = NonNullableValue,
  S extends NonNullableValue = NonNullableValue,
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
  O extends NonNullableValue = NonNullableValue,
  S extends NonNullableValue = NonNullableValue,
>(): ClientEventEmitter<O, S> {
  const listeners: {
    [K in ClientEventName]: Set<(payload: ClientEventMap<O, S>[K]) => void>;
  } = { dispose: new Set() };

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
