import { type Doc, type DocNode } from "./main.js";
import type {
  MoveOperation,
  Operations,
  OrderedOperation,
  TextOperation,
} from "./operations.js";

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

  export type Jsonified<T extends NodeDefinition> = {
    [K in keyof T["state"]]?: Json;
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
  /** The JSON of each default value, to leave it out of stored documents. */
  defaultJson: Record<string, Json>;
  methods: (node: DocNode) => NodeState.Methods<UnsafeDefinition>;
  /** Its keys of `text()`, if it has any. */
  textKeys: string[] | undefined;
};

/**
 * What a document asks of `text()` (see `text.ts`). The document reaches it
 * through the definitions `text()` makes (`textEngines`), so that only
 * documents with texts bundle it.
 */
export type TextEngine = {
  /** What `node.state[key]` gives for a text key. */
  methods(node: DocNode, key: string): unknown;
  /**
   * The node is inserted: its texts go into the document, and `ordered`
   * gets the inserts of their letters, after the insert of the node.
   */
  attach(node: DocNode, keys: string[], ordered: OrderedOperation[]): void;
  /**
   * The node is deleted: its texts leave the document, and with `inverse`,
   * the inserts that put their letters back after the node.
   */
  detach(node: DocNode, keys: string[], inverse?: OrderedOperation[]): void;
  /** Applies an insert of letters. */
  insert(doc: Doc, operation: TextOperation): void;
  /** Applies a delete of the letters from `start` to `end`. */
  delete(doc: Doc, start: string, end: string | 0): void;
  /** Applies a move of letters. */
  move(doc: Doc, operation: MoveOperation): void;
  /**
   * Writes the `letters` column of a stored document (see `JsonDoc`), one
   * text at a time. `sessionIndex` gives the index in the stored `sessions`
   * of a session of `NodeIds`.
   */
  lettersWriter(sessionIndex: (session: number) => number): {
    /** Writes the id runs of the non-empty text of the node's key. */
    write(node: DocNode, key: string): void;
    readonly column: number[];
  };
  /**
   * Reads the `letters` column of a stored document, one text at a time.
   * `sessions` has the index in `NodeIds` of each stored session.
   */
  lettersReader(
    column: unknown,
    sessions: number[],
  ): {
    /** The text of the node's key, `text` with the ids of its runs. */
    read(node: DocNode, key: string, text: string): unknown;
    /** Throws if the column has runs left. */
    end(): void;
  };
};

export type JsonDocNode<T extends NodeDefinition = NodeDefinition> = [
  id: string,
  type: T["type"],
  state: NodeState.Jsonified<T>,
];

/**
 * A document saved with `doc.toJSON()`, ready to load with `Doc.fromJSON`.
 * It is plain JSON. Its layout is internal, so store it as it is.
 */
export type JsonDoc =
  | [id: string, type: string, state: Record<string, Json>]
  | [
      id: string,
      type: string,
      state: Record<string, Json>,
      types: [name: string, ...keys: string[]][],
      type: number[],
      children: number[],
      states: number[],
      values: Json[],
      sessions: string[],
      ids: (number | string)[],
      ints?: string,
      letters?: number[],
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
  operations: Operations;
  inverseOperations: Operations;
  diff: Diff;
  flags: TransactionFlags;
};
