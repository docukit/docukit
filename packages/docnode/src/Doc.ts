import {
  type DocConfig,
  type JsonDoc,
  type NodeDefinition,
  type ResolvedNodeDefinition,
  type Json,
  type UnsafeDefinition,
  type Diff,
  type NodeState,
  type DefaultStateMethods,
  type ChangeEvent,
} from "./types.js";
import {
  withTransaction,
  isObjectEmpty,
  ULID_REGEX,
  defineNode,
} from "./utils.js";
import * as operations from "./operations.js";
import { nodeIdFactory } from "./idGenerator.js";
import { ulid } from "ulid";
import type { DocNode } from "./DocNode.js";

export class Doc {
  // private readonly _subDocs = new Map<string, Doc>();
  // private readonly _parentDoc?: Doc;
  protected _nodeDefs: Set<NodeDefinition>;
  private _resolvedNodeDefs: Map<string, ResolvedNodeDefinition>;
  private _strictMode: boolean;
  protected _nodeMap = new Map<string, DocNode>();
  private _changeListeners = new Set<(ev: ChangeEvent) => void>();
  private _normalizeListeners = new Set<(ev: { diff: Diff }) => void>();
  private _lifeCycleStage:
    | "init"
    | "idle"
    | "update"
    | "normalize"
    | "normalize2"
    | "change"
    | "disposed" = "idle";
  protected _operations: operations.Operations = [[], {}];
  protected _inverseOperations: operations.Operations = [[], {}];
  protected _diff: Diff = {
    deleted: new Map(),
    inserted: new Set(),
    moved: new Set(),
    updated: new Set(),
  };
  protected _nodeIdGenerator: (doc: Doc) => string;
  readonly root: DocNode;

  constructor(config: DocConfig) {
    this._nodeDefs = new Set();
    this._resolvedNodeDefs = new Map();
    const RootNode = defineNode({ type: config.type, state: {} });
    const nodeDefs: UnsafeDefinition[] = [
      RootNode,
      ...config.extensions.flatMap((extension) => extension.nodes ?? []),
    ];
    this._strictMode = config.strictMode ?? true;

    nodeDefs.forEach((nodeDef) => {
      const resolvedNodeDef = this._resolvedNodeDefs.get(nodeDef.type) ?? {
        type: nodeDef.type,
        state: {},
        defaultState: {},
        defaultStrings: {},
        methods: undefined as unknown as ResolvedNodeDefinition["methods"],
      };

      for (const key in nodeDef.state) {
        const state = nodeDef.state[key]!;
        if (resolvedNodeDef.state[key] !== undefined) {
          throw new Error(
            [
              `Collision error: attempt to register 2 node definitions of type`,
              `'${nodeDef.type}' that share the state property ${key}. Remove`,
              `that and any other repeated states in either of the two node definitions.`,
            ].join(" "),
          );
        } else {
          resolvedNodeDef.state[key] = state;
          const defaultState = state.fromJSON(undefined);
          resolvedNodeDef.defaultState[key] = defaultState;
          const defaultJson = state.toJSON
            ? state.toJSON(defaultState)
            : defaultState;
          const stringified = JSON.stringify(defaultJson);
          if (stringified === undefined) {
            throw new Error(
              `JSON serialization of the default value for state '${key}' of node type '${nodeDef.type}' is 'undefined', which is not allowed.`,
            );
          }
          resolvedNodeDef.defaultStrings[key] = stringified;
        }
      }

      this._resolvedNodeDefs.set(nodeDef.type, resolvedNodeDef);
      this._nodeDefs.add(nodeDef);
      if (!nodeDef.type) throw new Error(`Node does not have a type property`);
    });

    this._resolvedNodeDefs.forEach((resolvedNodeDef) => {
      resolvedNodeDef.methods = (node: DocNode) => {
        const stateObj = {} as NodeState.Methods<UnsafeDefinition>;

        for (const key in resolvedNodeDef.state) {
          //
          const get: DefaultStateMethods<unknown>["get"] = () => {
            // @ts-expect-error - protected property
            const _state = node._state as Record<string, unknown>;
            return key in _state
              ? _state[key]
              : resolvedNodeDef.defaultState?.[key];
          };

          /**
           * sets the state established by NodeDefinition. Like with `React.useState`
           * you may directly specify the value or use an updater function that will
           * be called with the previous value of the state on that node (which will
           * be the `defaultValue` if not set).
           *
           * @example
           * ```ts
           *   // set it directly
           *   docnode.state.counter.set(1);
           *   // or use an updater function:
           *   docnode.state.counter.set((current) => current + 1);
           * });
           * ```
           *
           * @param valueOrUpdaterFn The value or updater function
           */
          const set: DefaultStateMethods<unknown>["set"] = (
            valueOrUpdaterFn: unknown,
          ) =>
            withTransaction(node.doc, () => {
              // @ts-expect-error - protected property
              const _state = node._state as Record<string, unknown>;
              _state[key] ??= resolvedNodeDef.defaultState[key];
              if (_state[key] === valueOrUpdaterFn) return;

              const value =
                typeof valueOrUpdaterFn === "function"
                  ? (valueOrUpdaterFn as (prev: unknown) => unknown)(
                      _state[key],
                    )
                  : valueOrUpdaterFn;

              // [#4GOSK] we update patchState only when setting state for an attached
              // node or when inserting a node, but not when setting state for a node
              // that is not attached yet
              const isAttached = node.doc["_nodeMap"].has(node.id);
              if (isAttached) operations.onSetState.inverseOps(node, key);
              _state[key] = value;
              if (isAttached) operations.onSetState.operations(node, key);

              // TODO: Subdocs. This is not implemented yet
              // if (valueOrUpdaterFn instanceof Doc) {
              //   if (node._state[key]) throw new Error("Can't change a Doc reference");
              //   // @ts-expect-error - read-only property
              //   valueOrUpdaterFn.parentDoc = node.doc;
              //   const topLevelDoc = node.doc.getTopLevelDoc();
              //   topLevelDoc["_subDocs"].set(valueOrUpdaterFn.id, valueOrUpdaterFn);
              //   node._state[key] = valueOrUpdaterFn;
              //   return node;
              // }
            });
          const getPrev: DefaultStateMethods<unknown>["getPrev"] = () => {
            // I am not 100% sure if the condition should be:
            // if (!this._nodeMap.has(node.id) || this._diff.inserted.has(node.id))
            // Allowing getPrev on nodes that haven't been updated is an anti-pattern.
            // It means the user is likely dirty-checking all nodes.
            // But shouldn't it still not throw an error and leave it up to the user's decision?
            if (!this._diff.updated.has(node.id))
              throw new Error(
                [
                  "getPrev cannot be used on nodes that are not attached or that",
                  "have been inserted in the current transaction. Usually, you",
                  "will want to use getPrev with nodes from diff.updated.",
                ].join(" "),
              );
            const statePatch = node.doc["_inverseOperations"][1];
            const maybePrevState = statePatch[node.id]?.[key];
            // @ts-expect-error - protected property
            const _state = node._state as Record<string, unknown>;
            return maybePrevState
              ? [true, operations.parseStateKey(node, key, maybePrevState)]
              : [false, _state[key]];
          };

          // eslint-disable-next-line @typescript-eslint/unbound-method
          const methods = resolvedNodeDef.state[key]?.methods;

          stateObj[key] = methods?.({ get, set, getPrev }) ?? {
            get,
            set,
            getPrev,
          };
        }

        return stateObj;
      };
    });

    // Reasons why root id is required to be lowercase ulid:
    // - The ulid timestamp is used by nodeIdFactory to generate small IDs on other nodes.
    // - Database providers can be optimized by using ULIDs column type.
    // I could allow it when using a custom nodeIdFactory, but that's not supported
    // and is complex, error-prone, and confusing. For example, a user might want
    // to use ulid but accidentally make a mistake (e.g., uppercase).
    if (config.id && !ULID_REGEX.test(config.id)) {
      throw new Error(
        `Invalid document id: ${config.id}. It must be a lowercase ULID.`,
      );
    }

    const id = config.id ?? ulid().toLowerCase();
    // @ts-expect-error - private constructor
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.root = new DocNode(this, config.type, id);
    this._nodeMap.set(id, this.root);
    this._nodeIdGenerator =
      config.nodeIdGenerator === "ulid"
        ? () => ulid().toLowerCase()
        : nodeIdFactory(this);

    this._lifeCycleStage = "init";
    config.extensions.forEach((extension) => {
      extension.register?.(this);
    });
    this._lifeCycleStage = "idle";
  }

  getNodeById(docNodeId: string): DocNode | undefined {
    return this._nodeMap.get(docNodeId);
  }

  // TODO: Subdocs. This is not implemented yet
  // getTopLevelDoc() {
  //   let current: Doc = this;
  //   while (current._parentDoc) current = current._parentDoc;
  //   return current;
  // }

  // For simplicity, we will not allow spreading of nodeDefinitions like in
  // `is` method. Users should probably create their own wrappers instead.
  createNode<T extends NodeDefinition>(nodeDefinition: T): DocNode<T> {
    const type = nodeDefinition.type;
    if (!this._nodeDefs.has(nodeDefinition)) {
      throw new Error(
        `You attempted to create a node of type '${type}' with a node definition that was not registered.`,
      );
    }
    // @ts-expect-error - private constructor
    const node = new DocNode(this, type) as DocNode<T>;
    return node;
  }

  /** Internal utility used for all the high level insert methods. */
  private _insertRange(
    target: DocNode,
    position: "append" | "prepend" | "before" | "after",
    nodes: DocNode[],
  ) {
    if (nodes.length === 0) return;
    withTransaction(this, () => {
      if (
        (position === "before" || position === "after") &&
        target === this.root
      )
        throw new Error("Root node cannot have siblings");
      nodes.forEach((topLevelNode) => {
        topLevelNode.descendants({ includeSelf: true }).forEach((node) => {
          if (this !== node.doc)
            throw new Error("Node is from a different doc");
          if (this._nodeMap.has(node.id))
            // TODO: replace node.id with ${JSON.stringify(this.toJSON())). But for that,
            // I should probably setState in onApplyOperations, otherwise the state will not appear yet.
            throw new Error(
              `Node '${node.id}' cannot be inserted because it already exists in the doc.`,
            );
          if (node.type === this.root.type)
            throw new Error("You cannot insert nodes of type 'root'");
        });
      });
      if (
        position === "before" ||
        (position === "append" && this._nodeMap.has(target.id))
      ) {
        operations.onInsertRange(this, target, position, nodes);
      }
      switch (position) {
        case "append": {
          let current = target.last;
          nodes.forEach((node) => {
            node["_attachNode"]({ parent: target, prev: current });
            if (current) current["_set"]("next", node);
            else target["_set"]("first", node);
            current = node;
          });
          target["_set"]("last", current);
          break;
        }
        case "prepend": {
          if (target.first) this._insertRange(target.first, "before", nodes);
          else this._insertRange(target, "append", nodes);
          break;
        }
        case "before": {
          let current = target;
          const parent = target.parent!;
          for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i]!;
            node["_attachNode"]({
              parent: parent,
              next: current,
              prev: current.prev,
            });
            if (current.prev) current.prev["_set"]("next", node);
            current["_set"]("prev", node);
            current = node;
          }
          if (parent.first === target) parent["_set"]("first", nodes[0]);
          break;
        }
        case "after": {
          if (target.next) this._insertRange(target.next, "before", nodes);
          else this._insertRange(target.parent!, "append", nodes);
          break;
        }
      }
    });
  }

  /**
   * Registers a callback to be executed during the **change** phase of a transaction.
   *
   * The change phase occurs **after all updates and normalization** have been applied,
   * when the transaction is committed.
   *
   * - **Mutating the document is not allowed** during this phase. Attempts to do so will throw an error.
   * - Multiple change listeners can be registered.
   *
   * This is the ideal place to react to changes, such as updating a UI, storing the document, or storing the
   * operations of a transaction in a database.
   *
   * @param callback - Function called with a `ChangeEvent` object containing:
   *   - `operations`: operations applied in the transaction
   *   - `inverseOperations`: operations for undo
   *   - `diff`: summary of inserted, deleted, and moved nodes
   * @returns A function to unregister the listener.
   *
   * @example
   * ```ts
   * const offChange = doc.onChange((ev) => {
   *   console.log("Transaction committed:", ev.diff);
   * });
   * // later
   * offChange();
   * ```
   *
   * @throws If the document is **not** in the `idle` stage at the time of registration.
   */
  onChange = (callback: (ev: ChangeEvent) => void) => {
    if (
      this._lifeCycleStage !== "idle" &&
      this._lifeCycleStage !== "init" &&
      this._lifeCycleStage !== "update"
    )
      throw new Error(
        `You can't register a change event listener during the ${this._lifeCycleStage} stage`,
      );
    this._changeListeners.add(callback);
    return () => {
      this._changeListeners.delete(callback);
    };
  };

  /**
   * Registers a callback to be executed during the document's normalization phase.
   *
   * Lifecycle: `Idle -> Update -> Normalize -> Change`
   *
   * The normalize phase is the last chance to **mutate the document** to ensure
   * its consistency and validity.
   *
   * - Multiple normalize callbacks can be registered.
   * - Normalize callbacks are executed only once per transaction,
   * so it is recommended that they be idempotent (i.e. repeating them won't
   * cause the document to change).
   *
   * In strict mode, normalize callbacks are executed twice, but an error is thrown
   * if the callback mutates the document on the second pass.
   *
   * @param callback - Function called with an object containing the `diff` of the transaction.
   *
   * Unlike the change event, the normalize event can only be invoked during
   * the register of an Extension, and it cannot be unregistered.
   *
   * @example
   * ```ts
   * const MyExtension: Extension = {
   *   register: (doc) => {
   *     doc.onNormalize(({ diff }) => {
   *       // Ensure root has at least one child
   *       if (!doc.root.first) {
   *         doc.root.append(doc.createNode(MyNodeDef));
   *       }
   *     });
   *   },
   * };
   * ```
   *
   * @throws
   * - If strict mode is enabled and the callback mutates the document on the second pass.
   * - If onNormalize is invoked outside the register of an Extension.
   */
  onNormalize(callback: (ev: { diff: Diff }) => void) {
    if (this._lifeCycleStage !== "init")
      throw new Error(
        "You can't register a normalize event listener outside the register callback of an Extension",
      );
    this._normalizeListeners.add(callback);
  }

  applyOperations(_operations: operations.Operations) {
    withTransaction(
      this,
      () => {
        if (!_operations[0].length && isObjectEmpty(_operations[1])) return;
        operations.onApplyOperations(this, _operations);
      },
      true,
    );
  }

  /**
   * Terminates the transaction early and synchronously, triggering events.
   * Using forceCommit is uncommon and can hurt your app's performance.
   */
  forceCommit() {
    if (this._lifeCycleStage === "change")
      throw new Error("You can't trigger an update inside a change event");
    // push + reverse is more performant than unshift at insertion time
    this._inverseOperations[0].reverse();
    // End update stage before normalization
    this._lifeCycleStage = "idle";
    operations.maybeTriggerListeners(this);
    this._operations = [[], {}];
    this._inverseOperations = [[], {}];
    this._diff = {
      deleted: new Map(),
      inserted: new Set(),
      moved: new Set(),
      updated: new Set(),
    };
    this._lifeCycleStage = "idle";
  }

  /**
   * Aborts the current transaction and rolls back all changes.
   */
  abort() {
    const inverseOps: operations.Operations = [...this["_inverseOperations"]];
    this.applyOperations(inverseOps);
    this["_operations"] = [[], {}];
    this["_inverseOperations"] = [[], {}];
    this["_diff"] = {
      deleted: new Map(),
      inserted: new Set(),
      moved: new Set(),
      updated: new Set(),
    };
    this["_lifeCycleStage"] = "idle";
  }

  /**
   * This method unregisters all event listeners so the instance can be garbage-collected.
   *
   * After calling this method, the document can no longer be modified.
   */
  dispose() {
    if (this._lifeCycleStage !== "idle")
      throw new Error(
        `You can't dispose a document during the ${this._lifeCycleStage} stage`,
      );
    this._changeListeners.clear();
    this._normalizeListeners.clear();
    this._lifeCycleStage = "disposed";
  }

  toJSON(options?: { unsafe?: boolean }): JsonDoc {
    if (
      !options?.unsafe &&
      this._lifeCycleStage !== "idle" &&
      this._lifeCycleStage !== "change"
    ) {
      throw new Error(
        [
          "Cannot serialize a document during an active transaction.",
          "Its state may still change or be rolled back, so the output",
          "is not reliable for persistence. Prefer calling toJSON when",
          "the document is idle or in a change stage. Alternatively, use",
          "`toJSON({ unsafe: true })` for debugging.",
        ].join(" "),
      );
    }
    const nodeToJsonDoc = (node: DocNode): JsonDoc => {
      const jsonDoc: JsonDoc = node.toJSON();
      if (node.first) {
        const children: JsonDoc[] = [];
        node.children().forEach((childNode) => {
          children.push(nodeToJsonDoc(childNode));
        });
        jsonDoc[3] = children as [JsonDoc, ...JsonDoc[]];
      }
      return jsonDoc;
    };
    const jsonDoc = nodeToJsonDoc(this.root);
    return jsonDoc;
  }

  // NOTE: Maybe someday, if I find it necessary, I can make a non-static method.
  // For safety, I think I would make the strategy a required property. E.g.:
  // doc.fromJSON({jsonDoc, strategy: "overwrite" | "merge"});
  // What should happen to the listeners in this case? Should be configurable?
  // EDIT: I haven't needed it. It's super unsafe and dangerous. Best not to.
  /**
   * Creates a new doc from the given JSON.
   *
   * In the process, it dispatches an initial transaction,
   * so if you want to register listeners events immediately
   * afterward, you must first call doc.forceCommit().
   */
  static fromJSON(config: DocConfig, jsonDoc: JsonDoc): Doc {
    const id = jsonDoc[0];
    if (config.id && config.id !== id) {
      throw new Error(
        `Attempted to create a document with id '${config.id}' that does not match the root node id '${id}'.`,
      );
    }
    const doc = new Doc({ ...config, id });
    const jsonDocToDocNode = (node: DocNode, childrenJsonDoc: JsonDoc[]) => {
      const childrenNodes = childrenJsonDoc?.map((child) => {
        const childNode = doc._createNodeFromJson(child);
        return childNode;
      });
      if (childrenNodes) node.append(...childrenNodes);
      childrenJsonDoc?.forEach((childNode, index) => {
        const children = childNode[3];
        if (children) {
          jsonDocToDocNode(childrenNodes[index]!, children);
        }
      });
    };
    const root = doc._createNodeFromJson(jsonDoc);
    doc._nodeMap.delete(doc.root.id);
    // @ts-expect-error - read-only property
    doc.root = root;
    doc._nodeMap.set(doc.root.id, doc.root);
    if (jsonDoc[3]) jsonDocToDocNode(root, jsonDoc[3]);
    return doc;
  }

  private _createNodeFromJson(jsonNode: JsonDoc): DocNode {
    const [id, type] = jsonNode;
    // @ts-expect-error - private constructor
    const node = new DocNode(this, type, id) as DocNode;
    const state = this["_createStateFromJson"](jsonNode);
    // @ts-expect-error - read-only property
    node["_state"] = state;
    return node;
  }

  private _createStateFromJson(jsonNode: JsonDoc): Record<string, Json> {
    const [, type, stringifiedState] = jsonNode;
    const resolvedNodeDef = this._resolvedNodeDefs.get(type);
    if (!resolvedNodeDef)
      throw new Error(
        `Attempted to create a node of type '${type}' that was not registered.`,
      );
    const state: Record<string, Json> = {};
    for (const key in stringifiedState) {
      const stateString = stringifiedState[key]!;
      const stateJson = JSON.parse(stateString) as Json;
      const stateDefinition = resolvedNodeDef.state[key];
      if (!stateDefinition)
        throw new Error(
          `Attempted to create a node of type '${type}' with a state that is not registered: ${key}`,
        );
      state[key] = stateDefinition.fromJSON(stateJson) as Json;
    }
    return state;
  }
}
