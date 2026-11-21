import { type Doc, type DocNode } from "./main.js";
import type { EditOperation, Operations } from "./operations.js";
import type { SessionTable } from "./columns.js";

// For convention, we are not goint to uppercase all letters in Json (JSON),
// except in fromJSON and toJSON functions (for compatibility with the web standard).
// [#type-fest] - like Json from type-fest but without { toJSON(): Json }
export type Json =
  | string
  | number
  | boolean
  // eslint-disable-next-line @typescript-eslint/no-restricted-types
  | null
  | readonly Json[]
  | { [Key in string]?: Json };

export type DefaultJ<V> = [V] extends [{ toJSON(): infer R }]
  ? R extends Json
    ? R
    : V extends Json
      ? V
      : Json
  : V extends Json
    ? V
    : Json;

export type StateDefinition<
  V = unknown,
  J extends Json = DefaultJ<V>,
  M = unknown,
> = {
  /**
   * This function must return a default value when called with undefined,
   * otherwise it should parse the given JSON value to your type V. Note
   * that it is not required to copy or clone the given value, you can
   * pass it directly through if it matches the expected type.
   *
   * When you encounter an invalid value, it's up to you to decide
   * as to whether to ignore it and return the default value,
   * return some non-default error value, or throw an error.
   *
   * It is possible for V to include undefined, but if it does, then
   * it should also be considered the default value since undefined
   * can not be serialized to JSON so it is indistinguishable from the
   * default.
   *
   * Similarly, if your V is a function, then usage of set method
   * must use an updater function because your type will be indistinguishable
   * from an updater function.
   */
  // Theoretically, unknown could be replaced with `Json | undefined`,
  // but it's a very small gain.
  // never J, si el usuario está seguro, puede "mentir" con un
  // cast (json: Something)
  fromJSON(json: unknown): V;
  /**
   * This is optional and for advanced use cases only.
   * Specifically, you only need to define a `toJSON`
   * if the `fromJSON` can return a non-JSON serializable value.
   */
  toJSON?(value: V): J;
  methods?(methods: DefaultStateMethods<V>): M;
};

/**
 * @internal Capabilities of opt-in state kinds (like `defineText`) that
 * replicate as operations instead of as one absolute value per key.
 */
export type InternalStateDefinition<
  V = unknown,
  J extends Json = Json,
  M = unknown,
> = StateDefinition<V, J, M> & {
  /** Registers a state on the document root that holds the shared value. */
  docState?: { key: string; definition: InternalStateDefinition };
  /**
   * For the state `docState` registers: its value as the document stores
   * it, with the document's session table (see `Doc.toJSON`), or `0` when
   * there is nothing to store.
   */
  toStored?(
    value: V,
    sessions: SessionTable,
    columns: { encode(): string }[],
  ): Json[] | 0;
  /**
   * Reads what `toStored` wrote, with its columns (missing ones at the end
   * are empty) and the document's sessions.
   */
  fromStored?(stored: Json[], columns: string[], sessions: string[]): V;
  /** Applies an edit operation. Returns its inverse, or undefined if nothing changed. */
  applyEdit?(
    value: V,
    doc: Doc,
    operation: EditOperation,
  ): EditOperation | undefined;
  /** The operation an undo or redo of the history applies. */
  prepareUndo?(undo: EditOperation, doc: Doc): EditOperation;
  /** Called by `copy` so a state kind can duplicate its own value. */
  onCopy?(from: DocNode, to: DocNode): void;
  /** Receives the node, unlike the public `methods` hook. */
  methodsWithNode?(methods: DefaultStateMethods<V>, node: DocNode): M;
};

// Note: is important to use the method syntax, because It needs to be bivariant.
export type DefaultStateMethods<V> = {
  get(this: void): DeepImmutable<V>;
  getPrev(this: void): [changed: boolean, value: DeepImmutable<V>];
  set(this: void, value: V | ((prev: V) => V)): void;
};

export type StateRecord = Record<string, StateDefinition>;

export type NodeDefinition<
  T extends string = string,
  S extends StateRecord = Record<never, never>,
> = { type: T; state: S };

/** @internal */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace NodeState {
  export type Stringified<T extends NodeDefinition> = {
    [K in keyof T["state"]]?: string;
  };

  export type State<T extends NodeDefinition> = {
    [K in keyof T["state"]]?: T["state"][K] extends StateDefinition<
      infer V,
      Json
    >
      ? V
      : never;
  };

  export type Methods<T extends NodeDefinition> = {
    [K in keyof T["state"]]: T["state"][K] extends StateDefinition<
      infer _V,
      infer _J,
      infer M
    >
      ? M
      : never;
  };
}

export type UnsafeDefinition = NodeDefinition<string, StateRecord>;

export type ResolvedNodeDefinition = UnsafeDefinition & {
  defaultState: NodeState.State<UnsafeDefinition>;
  defaultStrings: NodeState.Stringified<UnsafeDefinition>;
  /** Each default as JSON, which a stored document compares values with. */
  defaultJson: Record<string, Json>;
  methods: (node: DocNode) => NodeState.Methods<UnsafeDefinition>;
};

export type JsonDocNode<T extends NodeDefinition = NodeDefinition> = [
  id: string,
  type: T["type"],
  state: NodeState.Stringified<T>,
];

/**
 * A stored document, as `Doc.toJSON` writes it (format 13). Elements at the
 * end that are empty are left out.
 *
 * The root is plain: its type and its state (each value as JSON). The
 * document's id is not stored: whoever stores the document keeps it next to
 * it, and `Doc.fromJSON` takes it from `config.id`.
 * The type comes second, at the same place as in a `JsonTree`: a binding that
 * picks the config by type reads it there in both.
 * Everything else is numbers in `columns` (see `columns.ts`), and the
 * strings they point to (the letters of `text` come before: gzip compresses
 * them better there):
 * - `sessions`: each without the start it shares with the one before (the
 *   first, with the document's id), whose length is the first column.
 * - The tree, in preorder: each node's session (an index in `sessions`,
 *   written as 0 for that of the node before, 1 for the one after the
 *   highest so far, else the index plus 2), its clock as the difference
 *   from the last one of its session plus one, its type (an index in
 *   `types`), its number of children and the keys of its state (twice
 *   their index in `keys`, plus one for a value in the column of numbers).
 *   A whole number that is not negative goes in that column, in base 93;
 *   the other values follow one another in `values`. The root's number of
 *   children goes first.
 * - The columns of `text`, the letter-by-letter text of the document (see
 *   `defineText`), which shares `sessions` with the tree.
 */
export type JsonDoc = [
  format: 13,
  type: string,
  state: { [key: string]: Json },
  sessions?: string[],
  types?: string[],
  keys?: string[],
  /** `0` when there is no text but more follows. */
  text?: Json[] | 0,
  columns?: string,
  values?: Json[],
];

/**
 * A document as nested nodes, `[id, type, state, children?]`, each state
 * value as a JSON string (a text value, as JSON). `Doc.fromJSON` reads it:
 * it is how DocNode stored documents before format 10, and it is easy to
 * write by hand.
 */
export type JsonTree = [
  id: string,
  type: string,
  state: Record<string, string | Json[]>,
  children?: [JsonTree, ...JsonTree[]],
];

/**
 * Information about nodes deleted, inserted, or updated during the transaction.
 *
 * @note
 * - It intentionally doesn't store enough information to restore the editor
 * to its previous state. That's what the inverseOperations of the change event is
 * for, which is what the undo manager uses under the hood.
 * - It does not store `updated` (nodes whose state has changed), because that is
 * what the patchState in operations[1] is for.
 */
export type Diff = {
  /**
   * Set of IDs of the nodes inserted during the transaction.
   */
  inserted: Set<string>;
  /**
   * Map of DocNode IDs to the DocNodes that were deleted during the transaction.
   */
  deleted: Map<string, DocNode>;
  /**
   * Set of IDs of the nodes that were moved during the transaction, either
   * because the move operation was used, or because they were deleted and
   * reinserted.
   */
  moved: Set<string>;
  /**
   * Set of IDs of the nodes whose state was updated during the transaction.
   * It does not include nodes that were inserted in the same transaction.
   */
  updated: Set<string>;
};

export type TransactionFlags = { skipUndo?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IntersectionOf<T extends any[]> = T extends [
  infer First,
  ...infer Rest,
]
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    First & IntersectionOf<Rest extends any[] ? Rest : []>
  : unknown;

export type IterableOptions = { includeSelf?: boolean };

// prettier-ignore
export type Find = {
  <DN extends DocNode>(predicate: (node: DocNode) => node is DN): DN | undefined;
  (predicate: (node: DocNode) => unknown): DocNode | undefined;
};

export type Extension = {
  nodes?: readonly NodeDefinition[];
  register?: (doc: Doc) => void;
};

export type NodeIdGenerator = {
  /** Generates a new ID string. */
  generate: () => string;
  /** Returns true if the given string is a valid ID. */
  validate: (id: string) => boolean;
  /**
   * Extracts the creation timestamp (in milliseconds) from an ID.
   * If defined, non-root nodes will use an optimized compact ID system
   * based on the elapsed time since the root node's creation.
   * If omitted, `generate` is used for all nodes.
   */
  extractTime?: ((id: string) => number) | undefined;
};

export type UndoManagerConfig = {
  /**
   * The maximum number of undo steps to keep in the undo stack.
   * If the number of undo steps exceeds this limit, the oldest undo step will be removed.
   * @default 0
   */
  maxUndoSteps?: number;
  /**
   * The interval in milliseconds to merge transactions into a single undo step.
   * Set to 0 to disable merging.
   * @default 500
   */
  mergeInterval?: number;
};

export type DocConfig = {
  extensions: Extension[];
  /**
   * If true, the document will throw an error if the normalize callback mutates the document on the second pass.
   */
  strictMode?: boolean;
  /**
   * The type of the document, which is also the root node type.
   * @example "editor", "file-explorer", "todo-list"
   */
  type: string;
  /**
   * The document id, which is also the root node id.
   * If not provided, will be generated by `nodeIdGenerator.generate()`.
   * Must pass `nodeIdGenerator.validate()`.
   */
  id?: string | undefined;
  /**
   * Custom ID generation strategy for the document.
   *
   * If not provided, defaults to lowercase ULID generation with the optimized
   * Lamport Timestamp system for non-root nodes.
   *
   * If `extractTime` is defined, non-root nodes will use an optimized compact ID
   * system based on the root node's timestamp. If `extractTime` is omitted,
   * `generate` will be used for all nodes (root and non-root).
   */
  nodeIdGenerator?: NodeIdGenerator;
  /**
   * Configures the document's built-in undo manager.
   */
  undoManager?: UndoManagerConfig;
};

// https://github.com/microsoft/TypeScript/issues/13923#issuecomment-2191862501
export type DeepImmutable<T> =
  T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends Set<infer S>
      ? ReadonlySet<DeepImmutable<S>>
      : T extends object
        ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
        : T;

export type ChangeEvent = {
  /** The batch to send to the other replicas. */
  operations: Operations;
  inverseOperations: Operations;
  diff: Diff;
  flags: TransactionFlags;
};
