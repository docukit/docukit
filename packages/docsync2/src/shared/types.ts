export type MaybePromise<T> = T | Promise<T>;

export type TransactionFlags = { skipUndo?: boolean };

export type Presence<T = unknown> = Record<string, T>;

export type SerializedDocPayload<S extends object = object> = {
  serializedDoc: S;
  docId: string;
  clock: number;
};

export type DocBinding<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> = {
  create(type: string, id: string): { doc: D; docId: string };
  deserialize(serializedDoc: S): D;
  serialize(doc: D): S;
  onChange(
    doc: D,
    cb: (ev: { operations: O; flags?: TransactionFlags }) => void,
  ): void | (() => void);
  applyOperations(doc: D, operations: O, flags?: TransactionFlags): void;
  // dispose(doc: D): void;
  // In this DocSync rewrite we have not found evidence that this is needed yet.
  // Once TanStack removes docs from query data, no strong references remain and
  // docs can be garbage-collected. GC.test.ts was added to detect possible regression.
};
