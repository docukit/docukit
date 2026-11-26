import {
  type DocConfig,
  type IntersectionOf,
  type JsonDoc,
  type JsonDocNode,
  type NodeDefinition,
  type ResolvedNodeDefinition,
  type Json,
  type IterableOptions,
  type UnsafeDefinition,
  type Find,
  type Diff,
  type NodeState,
  type DefaultStateMethods,
  type ChangeEvent,
  type NodeIdGenerator,
  type TransactionFlags,
  type StateDefinition,
} from "./types.js";
import {
  detachRange,
  withTransaction,
  isObjectEmpty,
  freezeInDev,
  equalJson,
  ULID_REGEX,
  defineNode,
} from "./utils.js";
import * as ops from "./operations.js";
import { NodeIds, numberToBase64 } from "./idGenerator.js";
import { decodeTime, ulid } from "ulid";
import { UndoManager } from "./undoManager.js";

/** Where a node keeps its document (see `DocNode.doc`). */
const DOC: unique symbol = Symbol("doc");
/** Where a node's `state` keeps the node (see `Doc`). */
const STATE_NODE: unique symbol = Symbol("node");
/** What `node.state[key]` gives. */
type StateKeyMethods = NodeState.Methods<UnsafeDefinition>[string];

export class DocNode<T extends NodeDefinition = NodeDefinition> {
  readonly id: string;
  readonly type: string;
  // It needs to be `protected` instead of `privated` to be compiled so that
  // ts does not infer `Record<never, string>` outside this package. See:
  // https://discord.com/channels/508357248330760243/1377072249252741160
  // https://github.com/microsoft/TypeScript/issues/38953#issuecomment-649839415
  protected readonly _state: NodeState.State<T>;
  readonly parent: DocNode | undefined;
  readonly prev: DocNode | undefined;
  readonly next: DocNode | undefined;
  readonly first: DocNode | undefined;
  readonly last: DocNode | undefined;
  // A symbol key instead of a property defined per node: assigning it costs
  // nothing, it stays out of `Object.keys` and JSON, and unlike a private
  // field (`#doc`) it can be read through a Proxy (Vue, MobX, Valtio).
  readonly [DOC]: Doc;
  /**
   * The index of the node's session in the document's table (`NodeIds`), or
   * -1 when its id is of another form. With `_clock`, it is the id as numbers.
   */
  protected readonly _session: number;
  protected readonly _clock: number;

  private constructor(
    doc: Doc,
    type: string,
    id?: string,
    session = -1,
    clock = 0,
  ) {
    this.type = type;
    this._state = {};
    this[DOC] = doc;
    const ids = doc["_nodeIds"];
    if (id === undefined && ids) {
      this._session = ids["_index"];
      this._clock = ids["_made"];
      this.id = ids.generate();
    } else {
      this._session = session;
      this._clock = clock;
      this.id = id ?? doc["_idGen"].generate();
    }
  }

  get doc() {
    return this[DOC];
  }

  /**
   * Links the node between `prev` and `next` under `parent`, and with
   * `attached` (a parent in the document) puts it and its descendants in the
   * document's map.
   */
  private _attachNode(
    parent: DocNode,
    prev: DocNode | undefined,
    next: DocNode | undefined,
    attached: boolean,
  ) {
    if (attached) this._register(this.doc["_nodeMap"]);
    this._set("parent", parent);
    this._set("prev", prev);
    this._set("next", next);
  }

  /** Puts the node and its descendants in `map`, without an iterator. */
  private _register(map: Map<string, DocNode>) {
    map.set(this.id, this);
    for (let child = this.first; child; child = child.next)
      child._register(map);
  }

  get state(): NodeState.Methods<T> {
    return this.doc["_resolvedNodeDefs"]
      .get(this.type)!
      .methods(this) as NodeState.Methods<T>;
  }

  private _set(
    prop: "parent" | "prev" | "next" | "first" | "last",
    node: DocNode | undefined,
  ) {
    // @ts-expect-error - read-only property
    this[prop] = node;
  }

  is<
    K extends string,
    NDs extends [NodeDefinition<K>, ...NodeDefinition<NDs[0]["type"]>[]],
  >(...nodeDefs: NDs): this is DocNode<IntersectionOf<NDs>> {
    // TODO:
    // 1. check that every nodeDef is registered
    // 2. check that the first nodeDef matches the node's type
    return nodeDefs[0]?.type === this.type;
  }

  // TO-DECIDE: maybe/someday
  // changeType(_newData: DocNode) {
  //   throw new Error("Not implemented yet");
  //   // this._data = newData;
  // }

  /**
   * Adds nodes as last children of this node
   */
  append(...nodes: DocNode[]) {
    this.doc["_insertRange"](this, "append", nodes);
  }

  /**
   * Adds nodes as first children of this node
   */
  prepend(...nodes: DocNode[]) {
    this.doc["_insertRange"](this, "prepend", nodes);
  }

  /**
   * Inserts nodes after this node
   * @throws If the node is the root node.
   */
  insertAfter(...nodes: DocNode[]) {
    this.doc["_insertRange"](this, "after", nodes);
  }

  /**
   * Inserts nodes before this node
   * @throws If the node is the root node.
   */
  insertBefore(...nodes: DocNode[]) {
    this.doc["_insertRange"](this, "before", nodes);
  }

  /**
   * delete the node and all its descendants.
   * @throws If the node is the root node.
   */
  delete() {
    this.to(this).delete();
  }

  /**
   * Deletes the children and descendants of this node.
   */
  deleteChildren() {
    const first = this.first;
    if (!first && this.doc["_lifeCycleStage"] === "change")
      throw new Error("You can't trigger an update inside a change event");
    first?.to(this.last!).delete();
  }

  /**
   * Replaces this node with the provided nodes.
   * @throws if the node is the root node.
   */
  replace(...nodes: DocNode[]) {
    this.to(this).replace(...nodes);
  }

  /**
   * Deletes the children of this node and adds the provided nodes as children.
   */
  replaceChildren(...nodes: DocNode[]) {
    if (this.first) this.first.to(this.last!).replace(...nodes);
    else this.append(...nodes);
  }

  /**
   * Moves this node to the target node in the provided position.
   * @throws if target is the same node or one of its descendants.
   */
  move(target: DocNode, position: "append" | "prepend" | "before" | "after") {
    this.to(this).move(target, position);
  }

  /**
   * Copies this node to the target node in the provided position.
   * The copied node will be the same except for the id, which will receive a new one.
   */
  copy(target: DocNode, position: "append" | "prepend" | "before" | "after") {
    this.to(this).copy(target, position);
  }

  /**
   * Returns a proxy object that allows to delete, replace, move and copy
   * the range of nodes from this node to the provided later sibling.
   * Any of those methods will throw an error if the argument `laterSibling`
   * is not a later sibling of this node or the same node
   *
   * @param laterSibling - The node that marks the end of the range.
   * @returns A proxy object with methods to modify the range of nodes.
   *
   */
  to(laterSibling: DocNode) {
    const doc = this.doc;
    // TODO: see tests
    // this.to(laterSibling).forEach((node) => {
    //   if (!this.doc["_nodeMap"].has(node.id))
    //     throw new Error(
    //       `For now, it's not allowed to delete, replace, move, or copy nodes that haven't been attached to the document yet. The node ${node.id} is not attached to the document.`,
    //     );
    // );

    const find: Find = (predicate: (node: DocNode) => unknown) => {
      let current: DocNode = this;
      while (true) {
        if (predicate(current)) return current;
        if (current === laterSibling) break;
        if (!current.next)
          throw new Error(
            `Node '${laterSibling.id}' is not a later sibling of '${this.id}'`,
          );
        current = current.next;
      }
      return undefined;
    };

    return {
      /**
       * Deletes the range of nodes from this node to the later sibling.
       */
      delete: () =>
        withTransaction(doc, () => {
          if (this === this.doc.root)
            throw new Error("Root node cannot be deleted");
          ops.onDeleteRange(this.doc, this, laterSibling);
          this.to(laterSibling).forEach((node) => {
            node.descendants({ includeSelf: true }).forEach((node) => {
              void this.doc["_nodeMap"].delete(node.id);
            });
          });
        }),
      /**
       * Replaces the range of nodes from this node to the later sibling with the provided nodes.
       */
      replace: (...nodes: DocNode[]) => {
        // TODO: Possible micro-optimization: make delete depend on
        // replace to avoid changing siblings' prev and next twice
        this.to(laterSibling).delete();
        if (this.prev) this.prev.insertAfter(...nodes);
        else if (laterSibling.next) laterSibling.next.insertBefore(...nodes);
        else this.parent!.append(...nodes);
      },
      /**
       * Moves the range of nodes from this node to the later sibling to the target node in the provided position.
       * @throws if target is in range or is a descendant of one of its nodes
       */
      move: (
        target: DocNode,
        position: "append" | "prepend" | "before" | "after",
      ) =>
        withTransaction(doc, () => {
          // PART 1: Validations
          if (
            (position === "before" && target.prev === laterSibling) ||
            (position === "after" && target.next === this) ||
            (position === "append" && target.last === laterSibling) ||
            (position === "prepend" && target.first === this)
          )
            return;

          const nodes = new Set<DocNode>();
          this.to(laterSibling).forEach((node) => {
            if (node === target) throw new Error("Target is in the range");
            nodes.add(node);
          });
          // Check if the target is a descendant of the range
          if (target.ancestors().find((node) => nodes.has(node)))
            throw new Error("Target is descendant of the range");

          const newPrev =
            position === "append"
              ? target.last
              : position === "before"
                ? target.prev
                : position === "after"
                  ? target
                  : undefined;
          const newNext =
            position === "prepend"
              ? target.first
              : position === "after"
                ? target.next
                : position === "before"
                  ? target
                  : undefined;
          const newParent =
            position === "append" || position === "prepend"
              ? target
              : target.parent!;

          if (!newParent)
            throw new Error("You can't move before or after the root");

          // PART 2: Detach the range
          detachRange(this, laterSibling);

          // PART 3: Insert the range
          ops.onMoveRange(doc, this, laterSibling, newParent, newPrev, newNext);

          this["_set"]("prev", newPrev);
          if (newPrev) newPrev["_set"]("next", this);
          else newParent["_set"]("first", this);
          laterSibling["_set"]("next", newNext);
          if (newNext) newNext["_set"]("prev", laterSibling);
          else newParent["_set"]("last", laterSibling);

          if (this.parent !== newParent) {
            this.to(laterSibling).forEach((node) => {
              node["_set"]("parent", newParent);
            });
          }
        }),
      /**
       * Copies the range of nodes from this node to the later sibling to the target node in the provided position.
       */
      copy: (
        target: DocNode,
        position: "append" | "prepend" | "before" | "after",
      ) => {
        withTransaction(doc, () => {
          const clone = (node: DocNode) => {
            const newNode = new DocNode(doc, node.type);
            for (const key in node["_state"]) {
              const stringified = ops.stringifyStateKey(node, key);
              const parsed = ops.parseStateKey(newNode, key, stringified);
              (newNode as DocNode<UnsafeDefinition>)["_state"][key] = parsed;
            }
            return newNode;
          };

          const traverse = (parent: DocNode, newParent: DocNode): void => {
            if (!parent.first) return;

            const clonedChildren: DocNode[] = [];
            let current: DocNode | undefined = parent.first;
            while (current) {
              const newNode = clone(current);
              clonedChildren.push(newNode);
              traverse(current, newNode);
              current = current.next;
            }

            doc["_insertRange"](newParent, "append", clonedChildren);
          };

          const topLevelClonedNodes: DocNode[] = [];
          this.to(laterSibling).forEach((topLevelNode) => {
            const newTopLevelNode = clone(topLevelNode);
            topLevelClonedNodes.push(newTopLevelNode);
            traverse(topLevelNode, newTopLevelNode);
          });

          doc["_insertRange"](target, position, topLevelClonedNodes);
        });
      },

      /**
       * Iterates over the range of nodes from this node to the later sibling.
       */
      forEach: (callback: (node: DocNode) => void) => {
        let current: DocNode = this;
        while (true) {
          callback(current);
          if (current === laterSibling) break;
          if (!current.next)
            throw new Error(
              `Node '${laterSibling.id}' is not a later sibling of '${this.id}'`,
            );
          current = current.next;
        }
      },
      find,
    };
  }

  children(options: IterableOptions = { includeSelf: false }) {
    const find: Find = (predicate: (node: DocNode) => unknown) => {
      if (options.includeSelf && predicate(this)) return this;
      let current = this.first;
      while (current) {
        if (predicate(current)) return current;
        current = current.next;
      }
      return undefined;
    };

    return {
      forEach: (callback: (node: DocNode) => void) => {
        if (options.includeSelf) {
          callback(this);
        }
        let current = this.first;
        while (current) {
          callback(current);
          current = current.next;
        }
      },
      find,
    };
  }

  ancestors(options: IterableOptions = { includeSelf: false }) {
    const find: Find = (predicate: (node: DocNode) => unknown) => {
      let current = options.includeSelf ? this : this.parent;
      while (current) {
        if (predicate(current)) return current;
        current = current.parent;
      }
      return undefined;
    };

    return {
      forEach: (callback: (node: DocNode, index: number) => void) => {
        let current = options.includeSelf ? this : this.parent;
        let index = 0;
        while (current) {
          callback(current, index);
          current = current.parent;
          index++;
        }
      },
      find,
    };
  }

  /**
   * Returns iterable methods `forEach` and `find`
   * over the descendants of this node.
   */
  descendants(options: IterableOptions = { includeSelf: false }) {
    const forEach = (callback: (node: DocNode, deepLevel: number) => void) => {
      const traverse = (node: DocNode | undefined, deepLevel: number): void => {
        let current = node;
        while (current) {
          callback(current, deepLevel);
          traverse(current.first, deepLevel + 1);
          current = current.next;
        }
      };
      if (options.includeSelf) callback(this, 0);
      traverse(this.first, 1);
    };

    const find: Find = (
      predicate: (node: DocNode) => unknown,
    ): DocNode | undefined => {
      const traverse = (node: DocNode | undefined): DocNode | undefined => {
        let current = node;
        while (current) {
          if (predicate(current)) return current;
          const hit = traverse(current.first);
          if (hit) return hit;
          current = current.next;
        }
        return undefined;
      };
      if (options.includeSelf && predicate(this)) return this;
      return traverse(this.first);
    };

    return { forEach, find };
  }

  prevSiblings(options: IterableOptions = { includeSelf: false }) {
    const find: Find = (predicate: (node: DocNode) => unknown) => {
      let current = options.includeSelf ? this : this.prev;
      while (current) {
        if (predicate(current)) return current;
        current = current.prev;
      }
      return undefined;
    };

    return {
      forEach: (callback: (node: DocNode) => void) => {
        let current = options.includeSelf ? this : this.prev;
        while (current) {
          callback(current);
          current = current.prev;
        }
      },
      find,
    };
  }

  nextSiblings(options: IterableOptions = { includeSelf: false }) {
    const find: Find = (predicate: (node: DocNode) => unknown) => {
      let current = options.includeSelf ? this : this.next;
      while (current) {
        if (predicate(current)) return current;
        current = current.next;
      }
      return undefined;
    };

    return {
      forEach: (callback: (node: DocNode) => void) => {
        let current = options.includeSelf ? this : this.next;
        while (current) {
          callback(current);
          current = current.next;
        }
      },
      find,
    };
  }

  toJSON(): JsonDocNode<T> {
    return [this.id, this.type, this._stateJson() as NodeState.Jsonified<T>];
  }

  /** Each value that is not the default, as a JSON string. */
  private _stateToJson(): NodeState.Stringified<T> {
    const jsonState: Record<string, string> = {};
    const values = this._stateJson();
    for (const key in values) jsonState[key] = JSON.stringify(values[key]);
    return jsonState as NodeState.Stringified<T>;
  }

  /** Each value that is not the default, as JSON (see `ops.stateKeyToJson`). */
  private _stateJson(): Record<string, Json> {
    const jsonState: Record<string, Json> = {};
    const defaults = this.doc["_resolvedNodeDefs"].get(this.type)!.defaultJson;
    for (const key in this._state) {
      const json = ops.stateKeyToJson(this, key);
      if (!equalJson(json, defaults[key])) jsonState[key] = json;
    }
    return jsonState;
  }
}

export class Doc {
  // private readonly _subDocs = new Map<string, Doc>();
  // private readonly _parentDoc?: Doc;
  protected _nodeDefs: Set<NodeDefinition>;
  private _resolvedNodeDefs: Map<string, ResolvedNodeDefinition>;
  private _strictMode: boolean;
  protected _nodeMap = new Map<string, DocNode>();
  protected _changeListeners = new Set<(ev: ChangeEvent) => void>();
  private _normalizeListeners = new Set<(ev: { diff: Diff }) => void>();
  private _lifeCycleStage:
    | "init"
    | "idle"
    | "update"
    | "normalize"
    | "normalize2"
    | "change"
    | "disposed" = "idle";
  protected _operations: ops.Operations = [[], {}];
  protected _inverseOperations: ops.Operations = [[], {}];
  protected _transactionFlags: TransactionFlags;
  private _isForceCommitCallback = false;
  protected _diff: Diff = {
    deleted: new Map(),
    inserted: new Set(),
    moved: new Set(),
    updated: new Set(),
  };
  protected _idGen: NodeIdGenerator;
  /** The ids of this document's session, unless a generator without time makes them. */
  protected _nodeIds: NodeIds | undefined;
  readonly root: DocNode;
  readonly undoManager: UndoManager;

  constructor(config: DocConfig) {
    this._nodeDefs = new Set();
    this._resolvedNodeDefs = new Map();
    const RootNode = defineNode({ type: config.type });
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
        defaultJson: {},
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
          resolvedNodeDef.defaultJson[key] = JSON.parse(stringified) as Json;
        }
      }

      this._resolvedNodeDefs.set(nodeDef.type, resolvedNodeDef);
      this._nodeDefs.add(nodeDef);
      if (!nodeDef.type) throw new Error(`Node does not have a type property`);
    });

    this._resolvedNodeDefs.forEach((resolvedNodeDef) => {
      // `node.state` binds the methods of a key when that key is read: a
      // node has several keys, and most reads use one.
      class State {
        [key: string]: StateKeyMethods;
        readonly [STATE_NODE]: DocNode<UnsafeDefinition>;
        constructor(node: DocNode<UnsafeDefinition>) {
          this[STATE_NODE] = node;
        }
      }
      for (const key in resolvedNodeDef.state) {
        const methodsOf = stateKeyMethods(
          key,
          resolvedNodeDef.state[key]!,
          resolvedNodeDef.defaultState[key],
        );
        Object.defineProperty(State.prototype, key, {
          enumerable: true,
          get(this: State) {
            return methodsOf(this[STATE_NODE]);
          },
        });
      }
      resolvedNodeDef.methods = (node: DocNode<UnsafeDefinition>) =>
        new State(node);
    });

    const idGen: NodeIdGenerator = config.nodeIdGenerator ?? {
      generate: () => ulid().toLowerCase(),
      validate: (id) => ULID_REGEX.test(id),
      extractTime: (id) => decodeTime(id.toUpperCase()),
    };

    this._idGen = idGen;

    if (config.id && !idGen.validate(config.id)) {
      throw new Error(`Invalid document id: ${config.id}.`);
    }

    const id = config.id ?? idGen.generate();
    // @ts-expect-error - private constructor
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.root = new DocNode(this, config.type, id);
    this._nodeMap.set(id, this.root);
    this._nodeIds = idGen.extractTime
      ? new NodeIds(this, idGen.extractTime)
      : undefined;

    this._lifeCycleStage = "init";
    config.extensions.forEach((extension) => {
      extension.register?.(this);
    });
    this._lifeCycleStage = "idle";
    this._forceCommit(true);
    this.undoManager = new UndoManager(this, config.undoManager);
    this._transactionFlags = { skipUndo: true };
    // If the first tx happens in the same microtask the doc is created,
    // we can skip the undo manager for that tx.
    // This makes even more sense when you consider that Doc.fromJSON
    // is not undoable and does not commit a transaction.
    queueMicrotask(() => {
      if (this._lifeCycleStage === "idle" && this._transactionFlags?.skipUndo) {
        this._transactionFlags = {};
      }
    });
  }

  /**
   * A node another replica inserted (or an undo inserts again). If its id is
   * of this document's session but past what it made, another replica has
   * the same session, so this one takes a new one (see `NodeIds`).
   */
  private _insertedNode(id: string, type: string) {
    const ids = this._nodeIds;
    if (!ids) {
      this._validateNodeId(id);
      return this._storedNode(id, type, -1, 0);
    }
    if (ids.collides(id)) ids.renew();
    const session = ids.split(id);
    return this._storedNode(id, type, session, ids.splitClock);
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
      // One pass per node and its descendants: inserting many nodes at once
      // (pasting, importing) costs the same per node as inserting one.
      for (const node of nodes) this._checkInsertable(node);
      switch (position) {
        case "append": {
          const attached = this._nodeMap.has(target.id);
          if (attached) ops.onInsertRange(this, target, position, nodes);
          let current = target.last;
          for (const node of nodes) {
            node["_attachNode"](target, current, undefined, attached);
            if (current) current["_set"]("next", node);
            else target["_set"]("first", node);
            current = node;
          }
          target["_set"]("last", current);
          break;
        }
        case "prepend": {
          if (target.first) this._insertRange(target.first, "before", nodes);
          else this._insertRange(target, "append", nodes);
          break;
        }
        case "before": {
          ops.onInsertRange(this, target, position, nodes);
          let current = target;
          const parent = target.parent!;
          const attached = this._nodeMap.has(parent.id);
          for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i]!;
            node["_attachNode"](parent, current.prev, current, attached);
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

  /** Throws unless `node` and its descendants can be inserted in this document. */
  private _checkInsertable(node: DocNode) {
    if (this !== node.doc) throw new Error("Node is from a different doc");
    if (this._nodeMap.has(node.id))
      // TODO: replace node.id with ${JSON.stringify(this.toJSON())). But for that,
      // I should probably setState in onApplyOperations, otherwise the state will not appear yet.
      throw new Error(
        `Node '${node.id}' cannot be inserted because it already exists in the doc.`,
      );
    if (node.type === this.root.type)
      throw new Error("You cannot insert nodes of type 'root'");
    for (let child = node.first; child; child = child.next)
      this._checkInsertable(child);
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

  applyOperations(operations: ops.Operations, flags?: TransactionFlags) {
    const hasOperations =
      operations[0].length > 0 || !isObjectEmpty(operations[1]);
    if (!hasOperations) {
      if (
        this._lifeCycleStage === "change" ||
        this._lifeCycleStage === "disposed"
      )
        throw new Error(
          `You can't trigger an update inside a ${this._lifeCycleStage} stage`,
        );
      if (this._lifeCycleStage === "normalize2") {
        throw new Error(
          "Strict mode has caught an error: normalize listeners are not idempotent. I.e, they should not mutate the document on the second pass.",
        );
      }
      return;
    }
    if (this._lifeCycleStage === "update") this.forceCommit();
    let didApplyOperations = false;
    if (flags) this._transactionFlags = flags;
    withTransaction(
      this,
      () => {
        ops.onApplyOperations(this, operations);
        didApplyOperations = true;
      },
      true,
    );
    if (didApplyOperations && this._lifeCycleStage === "update") {
      this.forceCommit();
    }
  }

  /**
   * Terminates the transaction early and synchronously, triggering events.
   * Using forceCommit is uncommon and can hurt your app's performance.
   */
  forceCommit(): void;
  forceCommit(callback: () => void, flags: TransactionFlags): void;
  forceCommit(callback?: () => void, flags: TransactionFlags = {}): void {
    if (this._isForceCommitCallback) {
      throw new Error(
        "You can't call forceCommit inside a forceCommit callback",
      );
    }
    this._forceCommit();
    if (!callback) return;
    this._transactionFlags = flags;
    this._isForceCommitCallback = true;
    try {
      withTransaction(this, callback);
      if (this._lifeCycleStage === "update") this._forceCommit();
      else this._transactionFlags = {};
    } finally {
      this._isForceCommitCallback = false;
    }
  }

  private _forceCommit(ignoreEmptyDiff = false) {
    if (this._lifeCycleStage === "change")
      throw new Error("You can't trigger an update inside a change event");
    // push + reverse is more performant than unshift at insertion time
    this._inverseOperations[0].reverse();
    // End update stage before normalization
    this._lifeCycleStage = "idle";
    ops.maybeTriggerListeners(this, ignoreEmptyDiff);
    this._operations = [[], {}];
    this._inverseOperations = [[], {}];
    this._transactionFlags = {};
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
    const inverseOps: ops.Operations = [...this["_inverseOperations"]];
    withTransaction(
      this,
      () => {
        ops.onApplyOperations(this, inverseOps);
      },
      true,
    );
    this["_operations"] = [[], {}];
    this["_inverseOperations"] = [[], {}];
    this["_transactionFlags"] = {};
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

  /**
   * The document as plain JSON (see `JsonDoc`), to store it or send it.
   *
   * State values are not copied: the result shares them with the document,
   * so do not change them in place. Use `set` to change a value.
   */
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
    return this._writeJson();
  }

  /**
   * The stored document: the root, then the other nodes in preorder as
   * columns (see `JsonDoc`). It is written in one pass, like the encoders of
   * lib0 (Yjs): the runs of ids are decided as the nodes come, without
   * looking ahead.
   */
  private _writeJson(): JsonDoc {
    const root = this.root;
    const rootState = root["_stateJson"]();
    if (!root.first) return [root.id, root.type, rootState];
    const types: string[] = [];
    const typeIndexes = new Map<string, number>();
    const typeColumn: number[] = [];
    const children: number[] = [0];
    const states: Record<string, Json>[] = [];
    const ids = new IdsWriter(this._nodeIds);
    let lastTypeName = "";
    let lastTypeIndex = 0;
    // A walk along the links, not a recursive closure: V8 can keep the
    // context of a closure it optimized, and with it the last document
    // written. `open` has the slot in `children` of each parent left open.
    const open = [0];
    let node: DocNode | undefined = root.first;
    while (node) {
      const at = open[open.length - 1]!;
      children[at] = children[at]! + 1;
      ids.write(node);
      const typeName = node.type;
      if (typeName !== lastTypeName) {
        let index = typeIndexes.get(typeName);
        if (index === undefined) {
          index = types.push(typeName) - 1;
          typeIndexes.set(typeName, index);
        }
        lastTypeName = typeName;
        lastTypeIndex = index;
      }
      typeColumn.push(lastTypeIndex);
      states.push(node["_stateJson"]());
      children.push(0);
      if (node.first) {
        open.push(children.length - 1);
        node = node.first;
        continue;
      }
      while (node !== root && !node.next) {
        node = node.parent!;
        open.pop();
      }
      node = node === root ? undefined : node.next;
    }
    ids.flush();
    const json: JsonDoc = [
      root.id,
      root.type,
      rootState,
      types,
      typeColumn,
      children,
      states,
      ids.sessions,
      ids.ids,
    ];
    return json;
  }

  // NOTE: Maybe someday, if I find it necessary, I can make a non-static method.
  // For safety, I think I would make the strategy a required property. E.g.:
  // doc.fromJSON({jsonDoc, strategy: "overwrite" | "merge"});
  // What should happen to the listeners in this case? Should be configurable?
  // EDIT: I haven't needed it. It's super unsafe and dangerous. Best not to.
  /**
   * Creates a new doc from the given JSON.
   *
   * The initial JSON import starts a transaction, allowing updates made
   * immediately afterward to be batched with it.
   *
   * State values are not copied: the document keeps the values of `jsonDoc`
   * (each through its definition's `fromJSON`), so do not change them in
   * place afterwards.
   */
  static fromJSON(config: DocConfig, jsonDoc: JsonDoc): Doc {
    const id = jsonDoc[0];
    if (config.id && config.id !== id) {
      throw new Error(
        `Attempted to create a document with id '${config.id}' that does not match the root node id '${id}'.`,
      );
    }
    const doc = new Doc({ ...config, id });
    withTransaction(doc, () => doc._readJson(jsonDoc));
    return doc;
  }

  /**
   * Builds the stored nodes of `json` (see `JsonDoc`) into this document,
   * recording them as inserts while it goes: what `ops.onInsertRange` records
   * when a tree is appended to the root, without walking it again.
   *
   * The new root and node map replace the document's only at the end, so a
   * load that throws halfway leaves the document as it was.
   */
  private _readJson(json: JsonDoc) {
    const [id, rootType, rootState] = json;
    const root = this._storedNode(id, rootType, -1, 0);
    this._readState(root, this._resolvedNodeDefs.get(rootType)!, rootState);
    const map = new Map([[id, root]]);
    if (json.length !== 3) this._readNodes(json, root, map);
    // @ts-expect-error - read-only property
    this.root = root;
    this._nodeMap = map;
  }

  /** Builds the nodes below `root` of a stored document into `map`. */
  private _readNodes(
    json: Extract<JsonDoc, { length: 9 }>,
    root: DocNode,
    map: Map<string, DocNode>,
  ) {
    const [, rootType, , types, typeColumn, children, states, sessions, ids] =
      json;
    const count = typeColumn.length;
    if (states.length !== count || children.length !== count + 1)
      throw new Error(
        "Invalid stored document: its columns do not have matching lengths.",
      );
    const definitions = types.map((name) => {
      if (name === rootType)
        throw new Error("You cannot insert nodes of type 'root'");
      const definition = this._resolvedNodeDefs.get(name);
      if (!definition)
        throw new Error(
          `Attempted to create a node of type '${name}' that was not registered.`,
        );
      return definition;
    });
    const nodeIds = this._nodeIds;
    // The index in `nodeIds` of each stored session, and the clock that
    // follows the last one read of each.
    const sessionIndexes = sessions.map(
      (session) => nodeIds?.register(session) ?? -1,
    );
    const nextClocks = sessions.map(() => 0);
    let idAt = 0;
    let runPrefix = "";
    let runSession = 0;
    let runClock = 0;
    let runLeft = 0;
    let runStep = 1;
    let index = 0;
    const inserts = this._operations[0];
    const patch = this._operations[1];
    const inserted = this._diff.inserted;
    // A loop with a stack of the parents left open, not a recursive closure:
    // V8 can keep the context of a closure it optimized, and with it every
    // array of the load (the columns and what was recorded).
    const open: [DocNode, number, DocNode | undefined, [string, string][]][] =
      [];
    let parent = root;
    let left = childCount(children, 0);
    let prev: DocNode | undefined;
    // One insert per list of children, in the order a walk finds them.
    let written: [string, string][] = [];
    // Columns without nodes (not what `toJSON` writes) insert nothing.
    if (left > 0) inserts.push([0, written, 0, 0, 0]);
    for (;;) {
      if (left === 0) {
        parent["_set"]("last", prev);
        const frame = open.pop();
        if (!frame) break;
        [parent, left, prev, written] = frame;
        continue;
      }
      left--;
      if (index === count)
        throw new Error(
          "Invalid stored document: it counts more children than it has nodes.",
        );
      let nodeId: string;
      let session = -1;
      let clock = 0;
      if (runLeft === 0) {
        const entry = ids[idAt++]!;
        if (typeof entry === "string") {
          // An id of a custom generator, or one `fromLegacyJson` kept.
          nodeId = entry;
          if (nodeIds) {
            session = nodeIds.split(entry);
            clock = nodeIds.splitClock;
          }
        } else {
          runSession += entry;
          const delta = ids[idAt++] as number;
          const length = ids[idAt++] as number;
          runPrefix = `${sessions[runSession]}.`;
          runClock = nextClocks[runSession]! + delta;
          runStep = length < 0 ? -1 : 1;
          runLeft = length * runStep;
          nextClocks[runSession] = runClock + runStep * (runLeft - 1) + 1;
        }
      }
      if (runLeft > 0) {
        session = sessionIndexes[runSession]!;
        clock = runClock;
        nodeId = runPrefix + numberToBase64(clock);
        runClock += runStep;
        runLeft--;
      }
      if (!nodeIds) this._validateNodeId(nodeId!);
      if (map.has(nodeId!))
        throw new Error(
          `Node '${nodeId!}' cannot be inserted because it already exists in the doc.`,
        );
      const definition = definitions[typeColumn[index]!];
      if (!definition)
        throw new Error(
          `Invalid stored document: node '${nodeId}' has type ${typeColumn[index]}, which is not in its types.`,
        );
      const type = definition.type;
      // @ts-expect-error - private constructor
      const node = new DocNode(this, type, nodeId!, session, clock) as DocNode;
      this._readState(node, definition, states[index++]!);
      const changed = node["_stateToJson"]();
      if (!isObjectEmpty(changed)) patch[nodeId!] = changed;
      written.push([nodeId!, type]);
      inserted.add(nodeId!);
      map.set(nodeId!, node);
      node["_set"]("parent", parent);
      if (prev) {
        node["_set"]("prev", prev);
        prev["_set"]("next", node);
      } else parent["_set"]("first", node);
      prev = node;
      const grandchildren = childCount(children, index);
      if (grandchildren > 0) {
        open.push([parent, left, prev, written]);
        parent = node;
        left = grandchildren;
        prev = undefined;
        written = [];
        inserts.push([0, written, node.id, 0, 0]);
      }
    }
    if (index !== count)
      throw new Error(
        "Invalid stored document: it has nodes that no parent counts.",
      );
    const { first, last } = root;
    if (first)
      this._inverseOperations[0].push([
        1,
        first.id,
        last !== first ? last!.id : 0,
      ]);
  }

  /**
   * Reads a stored state into `node`, each value through its key's
   * definition, which must be registered.
   */
  private _readState(
    node: DocNode,
    definition: ResolvedNodeDefinition,
    json: Record<string, Json>,
  ) {
    const state: Record<string, unknown> = node["_state"];
    for (const key in json) {
      const stateDefinition = definition.state[key];
      if (!stateDefinition)
        throw new Error(
          `Attempted to create a node of type '${node.type}' with a state that is not registered: ${key}`,
        );
      // The value is the stored document's, not a copy: frozen, like a
      // value set with `set`.
      state[key] = freezeInDev(stateDefinition.fromJSON(json[key]));
    }
  }

  /**
   * Throws if `id` is not valid for the document's generator. Only for a
   * custom generator without `extractTime`: `NodeIds` reads the others.
   */
  private _validateNodeId(id: string) {
    if (!this._idGen.validate(id)) throw new Error(`Invalid node id: ${id}.`);
  }

  /** A node of a stored document or of an operation, without state yet. */
  private _storedNode(
    id: string,
    type: string,
    session: number,
    clock: number,
  ) {
    if (!this._resolvedNodeDefs.has(type))
      throw new Error(
        `Attempted to create a node of type '${type}' that was not registered.`,
      );
    // @ts-expect-error - private constructor
    return new DocNode(this, type, id, session, clock) as DocNode;
  }
}

/**
 * Writes the ids of a stored document as runs (see `JsonDoc`), in one pass
 * like the encoders of lib0 (Yjs): a run is decided as the nodes come,
 * without looking ahead.
 */
class IdsWriter {
  readonly sessions: string[] = [];
  readonly ids: (number | string)[] = [];
  /**
   * The index in `sessions` of each session of `NodeIds`, and the clock that
   * follows the last one written of each session.
   */
  private readonly _indexes: number[] = [];
  private readonly _nextClocks: number[] = [];
  private _lastSession = 0;
  /** The run being written: its session, first and last clock, length, step. */
  private _session = -1;
  private _start = 0;
  private _last = 0;
  private _count = 0;
  private _step = 1;

  constructor(private readonly _nodeIds: NodeIds | undefined) {}

  write(node: DocNode) {
    const session = node["_session"];
    if (session < 0) {
      this.flush();
      this.ids.push(node.id);
      return;
    }
    const clock = node["_clock"];
    if (session === this._session && this._count > 0) {
      const last = this._last;
      if (this._count === 1 && (clock === last + 1 || clock === last - 1))
        this._step = clock - last;
      if (clock === last + this._step) {
        this._count++;
        this._last = clock;
        return;
      }
    }
    this.flush();
    this._session = session;
    this._start = this._last = clock;
    this._count = 1;
    this._step = 1;
  }

  flush() {
    if (this._count === 0) return;
    let index = this._indexes[this._session];
    if (index === undefined) {
      index = this._indexes[this._session] = this.sessions.length;
      this.sessions.push(this._nodeIds!.session(this._session));
      this._nextClocks.push(0);
    }
    this.ids.push(
      index - this._lastSession,
      this._start - this._nextClocks[index]!,
      this._count * this._step,
    );
    this._lastSession = index;
    this._nextClocks[index] = this._last + 1;
    this._count = 0;
  }
}

/**
 * The methods of one state key, chosen once per node definition. Reading
 * `node.state[key]` only binds them to the node, so `get`, `set` and
 * `getPrev` can still be called on their own (`this: void`).
 */
function stateKeyMethods(
  key: string,
  definition: StateDefinition,
  defaultValue: unknown,
) {
  // The logic is written inside each method instead of calling a shared
  // helper: an extra call per read measured ~50% slower once optimized.
  const methods = (
    node: DocNode<UnsafeDefinition>,
  ): DefaultStateMethods<unknown> => ({
    get: () => {
      const state = node["_state"];
      return key in state ? state[key] : defaultValue;
    },

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
    set: (valueOrUpdaterFn) =>
      withTransaction(node.doc, () => {
        const state = node["_state"];
        state[key] ??= defaultValue;
        if (state[key] === valueOrUpdaterFn) return;

        const value =
          typeof valueOrUpdaterFn === "function"
            ? (valueOrUpdaterFn as (prev: unknown) => unknown)(state[key])
            : valueOrUpdaterFn;

        // [#4GOSK] we update patchState only when setting state for an attached
        // node or when inserting a node, but not when setting state for a node
        // that is not attached yet
        const isAttached = node.doc["_nodeMap"].has(node.id);
        if (isAttached) ops.onSetState.inverseOps(node, key);
        // Frozen in development: a value changed in place would change the
        // document without an operation (see `freezeInDev`).
        state[key] = freezeInDev(value);
        if (isAttached) ops.onSetState.operations(node, key);

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
      }),

    getPrev: () => {
      // I am not 100% sure if the condition should be:
      // if (!doc._nodeMap.has(node.id) || doc._diff.inserted.has(node.id))
      // Allowing getPrev on nodes that haven't been updated is an anti-pattern.
      // It means the user is likely dirty-checking all nodes.
      // But shouldn't it still not throw an error and leave it up to the user's decision?
      const doc = node.doc;
      if (!doc["_diff"].updated.has(node.id))
        throw new Error(
          [
            "getPrev cannot be used on nodes that are not attached or that",
            "have been inserted in the current transaction. Usually, you",
            "will want to use getPrev with nodes from diff.updated.",
          ].join(" "),
        );
      const maybePrevState = doc["_inverseOperations"][1][node.id]?.[key];
      return maybePrevState
        ? [true, ops.parseStateKey(node, key, maybePrevState)]
        : [false, node["_state"][key]];
    },
  });

  // Called through `definition` (it may use `this`); `?.` only narrows the
  // type, the branch already checked it.
  if (definition.methods)
    return (node: DocNode<UnsafeDefinition>): StateKeyMethods =>
      definition.methods?.(methods(node));
  return methods;
}

/** The number of children of the stored node at `index` of `children`. */
function childCount(children: number[], index: number) {
  const count = children[index]!;
  if (!Number.isInteger(count) || count < 0)
    throw new Error(
      `Invalid stored document: ${count} is not a number of children.`,
    );
  return count;
}
