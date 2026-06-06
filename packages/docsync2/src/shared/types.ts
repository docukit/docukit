export type MaybePromise<T> = T | Promise<T>;

export type TransactionFlags = { skipUndo?: boolean };

export type Presence<T = unknown> = Record<string, T>;

export type DocQueryData<D extends object = object> = {
  docId: string;
  doc: D | undefined;
};

export type ExistingDocQueryData<D extends object = object> = {
  docId: string;
  doc: D;
};

export type DocQueryKey = readonly [
  "docukit",
  "docsync2",
  "doc",
  type: string,
  id: string,
];

export type PresenceQueryKey = readonly [
  "docukit",
  "docsync2",
  "presence",
  docId: string,
];

export type DocBinding<D extends object = object, S = unknown, O = unknown> = {
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
