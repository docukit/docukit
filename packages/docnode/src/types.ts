import { type Doc, type DocNode } from "./main.js";
import type { Operations } from "./operations.js";

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
> = {
  type: T;
  state: S;
};

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
  methods: (node: DocNode) => NodeState.Methods<UnsafeDefinition>;
};

export type JsonDocNode<T extends NodeDefinition = NodeDefinition> = [
  id: string,
  type: T["type"],
  state: NodeState.Stringified<T>,
];

export type JsonDoc = [
  id: string,
  type: string,
  state: Record<string, string>,
  children?: [JsonDoc, ...JsonDoc[]],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IntersectionOf<T extends any[]> = T extends [
  infer First,
  ...infer Rest,
]
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    First & IntersectionOf<Rest extends any[] ? Rest : []>
  : unknown;

export type IterableOptions = {
  includeSelf?: boolean;
};

// prettier-ignore
export type Find = {
  <DN extends DocNode>(predicate: (node: DocNode) => node is DN): DN | undefined;
  (predicate: (node: DocNode) => unknown): DocNode | undefined;
};

export type Extension = {
  nodes?: readonly NodeDefinition[];
  register?: (doc: Doc) => void;
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
   * It must be a lowercase ulid.
   * If not provided, will be generated by default.
   */
  id?: string | undefined;
  /**
   * It allows all nodes to be generated with a ulid.
   * If not defined, DocNode will use a Lamport Timestamp consisting of
   * the time elapsed since the document's creation and a random part, both in base64.
   * The default id is more compact than a ulid. This option is very rare and is
   * recommended only under extraordinary circumstances.
   */
  nodeIdGenerator?: "ulid";
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
};
