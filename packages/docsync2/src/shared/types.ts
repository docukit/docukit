export type MaybePromise<T> = T | Promise<T>;

export type TransactionFlags = { skipUndo?: boolean };

export type Presence<T = unknown> = Record<string, T>;

export type NonNullableValue = NonNullable<unknown>;

export type DocBinding<
  D extends NonNullableValue = NonNullableValue,
  S extends NonNullableValue = NonNullableValue,
  O extends NonNullableValue = NonNullableValue,
> = {
  create(type: string, id: string): { doc: D; docId: string };
  deserialize(serializedDoc: S): D;
  serialize(doc: D): S;
  onChange(
    doc: D,
    cb: (ev: { operations: O; flags?: TransactionFlags }) => void,
  ): void | (() => void);
  applyOperations(doc: D, operations: O, flags?: TransactionFlags): void;
  dispose(doc: D): void;
};
