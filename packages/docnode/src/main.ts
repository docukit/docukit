import { readJsonDoc, writeJsonDoc } from "./jsonDoc.js";
import {
  type DocConfig,
  type IntersectionOf,
  type JsonDoc,
  type JsonDocNode,
  type JsonTree,
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
  type InternalStateDefinition,
  type NodeIdGenerator,
  type TransactionFlags,
  type CrdtEngine,
} from "./types.js";
import {
  detachRange,
  withTransaction,
  checkUpdate,
  ULID_REGEX,
  defineNode,
  idRecord,
  jsonCopy,
  parseJson,
} from "./utils.js";
import { NodeIds } from "./idGenerator.js";
import { decodeOperations } from "./wire.js";
import * as ops from "./operations.js";
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

  private constructor(
    doc: Doc,
    type: string,
    id?: string,
    // Sized to the keys of its type (see `ResolvedNodeDefinition.Values`).
    state = new (doc["_resolvedNodeDefs"].get(type)!.Values)(),
  ) {
    this.type = type;
    // @ts-expect-error - a stored node is built with its state already read
    this._state = state;
    this[DOC] = doc;
    this.id = id ?? doc["_createNodeId"]();
  }

  get state(): NodeState.Methods<T> {
    return this.doc["_resolvedNodeDefs"]
      .get(this.type)!
      .methods(this) as NodeState.Methods<T>;
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
    if (attached) DocNode.#register(this, this.doc["_nodeMap"]);
    // @ts-expect-error - read-only property
    this.parent = parent;
    // @ts-expect-error - read-only property
    this.prev = prev;
    // @ts-expect-error - read-only property
    this.next = next;
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
   * Replaces this node with the provided nodes.
   * @throws if the node is the root node.
   */
  replace(...nodes: DocNode[]) {
    this.to(this).replace(...nodes);
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
   * Deletes the children and descendants of this node.
   */
  deleteChildren() {
    const first = this.first;
    if (!first && this.doc["_lifeCycleStage"] === "change")
      throw new Error("You can't trigger an update inside a change event");
    first?.to(this.last!).delete();
  }

  /**
   * Deletes the children of this node and adds the provided nodes as children.
   */
  replaceChildren(...nodes: DocNode[]) {
    if (this.first) this.first.to(this.last!).replace(...nodes);
    else this.append(...nodes);
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

          // @ts-expect-error - read-only property
          this.prev = newPrev;
          // @ts-expect-error - read-only property
          if (newPrev) newPrev.next = this;
          // @ts-expect-error - read-only property
          else newParent.first = this;
          // @ts-expect-error - read-only property
          laterSibling.next = newNext;
          // @ts-expect-error - read-only property
          if (newNext) newNext.prev = laterSibling;
          // @ts-expect-error - read-only property
          else newParent.last = laterSibling;

          if (this.parent !== newParent) {
            this.to(laterSibling).forEach((node) => {
              // @ts-expect-error - read-only property
              node.parent = newParent;
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
            const resolvedDef = doc["_resolvedNodeDefs"].get(node.type);
            for (const key in resolvedDef?.state) {
              const definition: InternalStateDefinition | undefined =
                resolvedDef.state[key];
              definition?.onCopy?.(node, newNode);
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

  /**
   * Adds nodes as first children of this node
   */
  prepend(...nodes: DocNode[]) {
    this.doc["_insertRange"](this, "prepend", nodes);
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

  /**
   * Moves this node to the target node in the provided position.
   * @throws if target is the same node or one of its descendants.
   */
  move(target: DocNode, position: "append" | "prepend" | "before" | "after") {
    this.to(this).move(target, position);
  }

  toJSON(): JsonDocNode<T> {
    return [this.id, this.type, this._stateToJson(true)];
  }

  /**
   * Copies this node to the target node in the provided position.
   * The copied node will be the same except for the id, which will receive a new one.
   */
  copy(target: DocNode, position: "append" | "prepend" | "before" | "after") {
    this.to(this).copy(target, position);
  }

  /**
   * Each value as a JSON string. With `stored`, the document's text value
   * is kept as JSON (from format 8): it is most of a document's JSON, and a
   * string would be escaped again inside it.
   */
  private _stateToJson(stored = false): NodeState.Stringified<T> {
    const jsonState: Record<string, string | Json[]> = {};
    const resolvedNodeDef = this.doc["_resolvedNodeDefs"].get(this.type);
    const defaultString = resolvedNodeDef?.defaultStrings;
    const editKey = stored ? this.doc["_editStateKey"] : undefined;
    for (const key in this._state) {
      if (key === editKey && this === this.doc.root) {
        const json = resolvedNodeDef?.state[key]?.toJSON?.(this._state[key]);
        // An empty text value is the default one.
        if (Array.isArray(json)) jsonState[key] = json;
        continue;
      }
      // Serialized once: a text value is most of a document's JSON.
      const stringifiedState = ops.stringifyStateKey(this, key);
      if (stringifiedState === defaultString?.[key]) continue;
      jsonState[key] = stringifiedState;
    }
    return jsonState as NodeState.Stringified<T>;
  }

  /**
   * Puts `node` and its descendants in `map`, without an iterator. Static:
   * a private method of the instances would cost each node a slot (the
   * class brand).
   */
  static #register(node: DocNode, map: Map<string, DocNode>) {
    map.set(node.id, node);
    for (let child = node.first; child; child = child.next)
      DocNode.#register(child, map);
  }
}

export class Doc {
  // private readonly _subDocs = new Map<string, Doc>();
  // private readonly _parentDoc?: Doc;
  protected _nodeDefs: Set<NodeDefinition>;
  protected _resolvedNodeDefs: Map<string, ResolvedNodeDefinition>;
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
  protected _hasEdits = false;
  protected _operations: ops.DraftOperations = [[], {}];
  protected _inverseOperations: ops.DraftOperations = [[], {}];
  /**
   * The last batch this transaction applied and what it decoded to: when it
   * is all the transaction did, it is the transaction's `operations`.
   */
  protected _received: ops.Operations | undefined;
  protected _decoded: ops.DraftOperations | undefined;
  /**
   * The change event a CRDT engine already built for this transaction (for a
   * remote batch it merged): the document does not encode its own. The
   * engine sets and clears it.
   */
  protected _event: ChangeEvent | undefined;
  /** Root state that receives edit operations (see `docState`). */
  protected _editStateKey: string | undefined;
  /** Its definition, which applies the edit operations. */
  protected _editDefinition: InternalStateDefinition | undefined;
  protected _transactionFlags: TransactionFlags;
  private _isForceCommitCallback = false;
  /** Whether a microtask will commit the transaction (see `withTransaction`). */
  protected _commitScheduled = false;
  /** How many transactions ended: the number of the one being written. */
  protected _commits = 0;
  protected _diff: Diff = {
    deleted: new Map(),
    inserted: new Set(),
    moved: new Set(),
    updated: new Set(),
  };
  protected _nodeIdGenerator: (doc: Doc) => string;
  protected _idGen: NodeIdGenerator;
  /** The ids of this document's session, unless a generator without time makes them. */
  #nodeIds: NodeIds | undefined;
  /**
   * How many times this document took a new session (see `NodeIds`): what
   * keeps its own counters, like the text, starts over.
   */
  protected _sessionRenewals = 0;
  /** Only with `DocConfig.crdt`. */
  protected _crdt: CrdtEngine | undefined;
  readonly root: DocNode;
  readonly undoManager: UndoManager;

  constructor(config: DocConfig) {
    this._strictMode = config.strictMode ?? true;
    [
      this._nodeDefs,
      this._resolvedNodeDefs,
      this._editStateKey,
      this._editDefinition,
    ] = resolve(config);

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
    this.#nodeIds = idGen.extractTime
      ? new NodeIds(this, idGen.extractTime)
      : undefined;
    this._nodeIdGenerator = this.#nodeIds?.generate ?? idGen.generate;
    // Before the extensions and the undo manager: the engine sees them come.
    this._crdt = config.crdt?.(this);

    this._lifeCycleStage = "init";
    config.extensions.forEach((extension) => {
      extension.register?.(this);
    });
    this._lifeCycleStage = "idle";
    this.#forceCommit(true);
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
   * Aborts the current transaction and rolls back all changes.
   */
  abort() {
    const inverseOps: ops.DraftOperations = [...this["_inverseOperations"]];
    withTransaction(
      this,
      () => {
        ops.onApplyOperations(this, inverseOps);
      },
      true,
    );
    this["_operations"] = [[], {}];
    this["_inverseOperations"] = [[], {}];
    this["_received"] = undefined;
    this["_decoded"] = undefined;
    this["_hasEdits"] = false;
    this["_transactionFlags"] = {};
    this["_diff"] = {
      deleted: new Map(),
      inserted: new Set(),
      moved: new Set(),
      updated: new Set(),
    };
    this["_lifeCycleStage"] = "idle";
    this._commits++;
  }

  applyOperations(operations: ops.Operations, flags?: TransactionFlags) {
    if (operations.length < 2) return checkUpdate(this);
    if (this._lifeCycleStage === "update") this.forceCommit();
    let didApplyOperations = false;
    if (flags) this._transactionFlags = flags;
    withTransaction(
      this,
      () => {
        const draft = decodeOperations(operations);
        this._received = operations;
        this._decoded = draft;
        ops.onApplyOperations(this, draft);
        didApplyOperations = true;
      },
      true,
    );
    if (didApplyOperations && this._lifeCycleStage === "update") {
      this.forceCommit();
    }
  }

  /** The id of a new node: a CRDT engine can choose it (see `DocConfig.crdt`). */
  private _createNodeId() {
    return this._nodeIdGenerator(this);
  }

  /** A stored state value, from its JSON. */
  private _storedValue(
    definition: ResolvedNodeDefinition,
    key: string,
    json: Json,
  ): unknown {
    const state = definition.state[key];
    if (!state)
      throw new Error(
        `Attempted to create a node of type '${definition.type}' with a state that is not registered: ${key}`,
      );
    return state.fromJSON(json);
  }

  #forceCommit(ignoreEmptyDiff = false) {
    if (this._lifeCycleStage === "change")
      throw new Error("You can't trigger an update inside a change event");
    // push + reverse is more performant than unshift at insertion time
    this._inverseOperations[0].reverse();
    // End update stage before normalization
    this._lifeCycleStage = "idle";
    ops.maybeTriggerListeners(this, ignoreEmptyDiff);
    // A document that inserts nodes gets patches keyed by new ids each time
    // (see `idRecord`).
    if (this._diff.inserted.size > 0) this.#insertsNodes = true;
    this._operations = [[], this.#insertsNodes ? idRecord() : {}];
    this._inverseOperations = [[], {}];
    this._received = undefined;
    this._decoded = undefined;
    this._hasEdits = false;
    this._transactionFlags = {};
    this._diff = {
      deleted: new Map(),
      inserted: new Set(),
      moved: new Set(),
      updated: new Set(),
    };
    this._lifeCycleStage = "idle";
    this._commits++;
  }

  /** A node another replica inserted (see `_renewSession`). */
  private _checkSession(id: string) {
    if (this.#nodeIds?.collides(id)) this._renewSession();
  }

  /**
   * After an id or a letter of this document's session that it did not make
   * yet: another replica has the same session, so this one takes a new one
   * (see `NodeIds`).
   */
  private _renewSession() {
    if (!this.#nodeIds) return;
    this.#nodeIds.renew();
    this._sessionRenewals++;
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

  /** Puts a stored root in place of the one the constructor created. */
  private _setStoredRoot(root: DocNode): void {
    // Nodes a normalize listener created for the replaced root are gone.
    this._nodeMap.clear();
    // @ts-expect-error - read-only property
    this.root = root;
    this._nodeMap.set(root.id, root);
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

  /** Whether a transaction of this document inserted nodes. */
  #insertsNodes = false;
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
    this.#forceCommit();
    if (!callback) return;
    this._transactionFlags = flags;
    this._isForceCommitCallback = true;
    try {
      withTransaction(this, callback);
      if (this._lifeCycleStage === "update") this.#forceCommit();
      else this._transactionFlags = {};
    } finally {
      this._isForceCommitCallback = false;
    }
  }

  /** Throws unless `node` and its descendants can be inserted in this document. */
  #checkInsertable(node: DocNode) {
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
      this.#checkInsertable(child);
  }

  /**
   * The document as it is stored (see `JsonDoc`). Its id is not part of it:
   * store it next to the document, and pass it to `Doc.fromJSON` as
   * `config.id`.
   */
  toJSON(options?: { unsafe?: boolean }): JsonDoc {
    if (
      !options?.unsafe &&
      this._lifeCycleStage !== "idle" &&
      this._lifeCycleStage !== "change"
    ) {
      throw new Error(
        "Cannot serialize a document during an active transaction. " +
          "Its state may still change or be rolled back, so the output " +
          "is not reliable for persistence. Prefer calling toJSON when " +
          "the document is idle or in a change stage. Alternatively, use " +
          "`toJSON({ unsafe: true })` for debugging.",
      );
    }
    return writeJsonDoc(this);
  }

  /** The definition of a stored node's type, which must be registered. */
  private _storedDefinition(type: string): ResolvedNodeDefinition {
    const definition = this._resolvedNodeDefs.get(type);
    if (!definition)
      throw new Error(
        `Attempted to create a node of type '${type}' that was not registered.`,
      );
    return definition;
  }

  /** The children of a `JsonTree` node, linked under `parent`. */
  #attachTree(parent: DocNode, children: JsonTree[] | undefined) {
    if (!children) return;
    let prev: DocNode | undefined;
    for (const json of children) {
      const node = this._nodeFromTree(json);
      this._linkStored(parent, prev, node);
      prev = node;
      this.#attachTree(node, json[3]);
    }
    // @ts-expect-error - read-only property
    parent.last = prev;
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

  /** A node of a stored document, with its state already read. */
  private _storedNode(
    id: string,
    type: string,
    state: Record<string, unknown>,
  ): DocNode {
    if (!this._idGen.extractTime && !this._idGen.validate(id)) {
      throw new Error(`Invalid node id: ${id}.`);
    }
    // @ts-expect-error - private constructor
    return new DocNode(this, type, id, state) as DocNode;
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
   * immediately afterward to be batched with it. A document stored by
   * `toJSON` takes its id from `config.id`, which is then required.
   */
  static fromJSON(config: DocConfig, storedDoc: JsonDoc | JsonTree): Doc {
    // Unreleased versions wrote a number first.
    if (typeof storedDoc[0] === "number")
      throw new Error(`Unsupported format: ${JSON.stringify(storedDoc[0])}`);
    const id = isTree(storedDoc) ? storedDoc[0] : config.id;
    if (!id)
      throw new Error(
        "A document stored by `toJSON` does not keep its id: pass it as `config.id`.",
      );
    if (config.id && config.id !== id) {
      throw new Error(
        `Attempted to create a document with id '${config.id}' that does not match the root node id '${id}'.`,
      );
    }
    const json = config.extensions.reduce(
      (json, extension) => extension.load?.(json, id) ?? json,
      storedDoc,
    );
    const doc = new Doc({ ...config, id });
    withTransaction(doc, () => {
      if (!isTree(json)) return readJsonDoc(doc, json);
      doc._setStoredRoot(doc._nodeFromTree(json));
      doc.#attachTree(doc.root, json[3]);
    });
    // In the transaction of the load, which is still open.
    doc._crdt?.load(json);
    return doc;
  }

  private _nodeFromTree([id, type, stored]: JsonTree): DocNode {
    const definition = this._storedDefinition(type);
    const state = new definition.Values();
    for (const key in stored) {
      const value = stored[key]!;
      // A text value is JSON, any other a JSON string.
      const json = typeof value === "string" ? parseJson(value) : value;
      state[key] = this._storedValue(definition, key, json);
    }
    return this._storedNode(id, type, state);
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
      for (const node of nodes) this.#checkInsertable(node);
      switch (position) {
        case "append": {
          const attached = this._nodeMap.has(target.id);
          if (attached) ops.onInsertRange(this, target, position, nodes);
          let current = target.last;
          for (const node of nodes) {
            node["_attachNode"](target, current, undefined, attached);
            // @ts-expect-error - read-only property
            if (current) current.next = node;
            // @ts-expect-error - read-only property
            else target.first = node;
            current = node;
          }
          // @ts-expect-error - read-only property
          target.last = current;
          break;
        }
        case "prepend": {
          if (target.first) this._insertRange(target.first, "before", nodes);
          else this._insertRange(target, "append", nodes);
          break;
        }
        case "before": {
          const parent = target.parent!;
          const attached = this._nodeMap.has(parent.id);
          if (attached) ops.onInsertRange(this, target, position, nodes);
          let current = target;
          for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i]!;
            node["_attachNode"](parent, current.prev, current, attached);
            // @ts-expect-error - read-only property
            if (current.prev) current.prev.next = node;
            // @ts-expect-error - read-only property
            current.prev = node;
            current = node;
          }
          // @ts-expect-error - read-only property
          if (parent.first === target) parent.first = nodes[0];
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
   * Links a stored node after `prev`, the last child of `parent` so far. It
   * is the document as it was, not a change: nothing is recorded for the
   * transaction.
   */
  private _linkStored(
    parent: DocNode,
    prev: DocNode | undefined,
    node: DocNode,
  ): void {
    if (node.type === this.root.type)
      throw new Error("You cannot insert nodes of type 'root'");
    // One lookup: a map that does not grow already had the id. The document
    // being loaded is then thrown away.
    const size = this._nodeMap.size;
    this._nodeMap.set(node.id, node);
    if (this._nodeMap.size === size)
      throw new Error(
        `Node '${node.id}' cannot be inserted because it already exists in the doc.`,
      );
    // @ts-expect-error - read-only property
    node.parent = parent;
    // @ts-expect-error - read-only property
    node.prev = prev;
    // @ts-expect-error - read-only property
    if (prev) prev.next = node;
    // @ts-expect-error - read-only property
    else parent.first = node;
  }

  getNodeById(docNodeId: string): DocNode | undefined {
    return this._nodeMap.get(docNodeId);
  }
}

const isTree = (json: JsonDoc | JsonTree): json is JsonTree =>
  typeof json[0] === "string";

/**
 * The methods of one state key, chosen once per node definition. Reading
 * `node.state[key]` only binds them to the node, so `get`, `set` and
 * `getPrev` can still be called on their own (`this: void`).
 */
function stateKeyMethods(
  key: string,
  definition: InternalStateDefinition,
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
        state[key] = value;
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
          "getPrev cannot be used on nodes that are not attached or that " +
            "have been inserted in the current transaction. Usually, you " +
            "will want to use getPrev with nodes from diff.updated.",
        );
      const maybePrevState = doc["_inverseOperations"][1][node.id]?.[key];
      return maybePrevState
        ? [true, ops.parseStateKey(node, key, maybePrevState)]
        : [false, node["_state"][key]];
    },
  });

  // Called through `definition` (they may use `this`); `?.` only narrows
  // the type, the branch already checked them.
  if (definition.methodsWithNode)
    return (node: DocNode<UnsafeDefinition>): StateKeyMethods =>
      definition.methodsWithNode?.(node);
  if (definition.methods)
    return (node: DocNode<UnsafeDefinition>): StateKeyMethods =>
      definition.methods?.(methods(node));
  return methods;
}

/** What a document makes of its definitions (see `resolve`). */
type Resolved = [
  defs: Set<NodeDefinition>,
  resolvedDefs: Map<string, ResolvedNodeDefinition>,
  editStateKey?: string,
  editDefinition?: InternalStateDefinition,
];
/** The resolved definitions, by the definitions they come from (see `resolve`). */
type ResolvedCache = {
  next?: WeakMap<object, ResolvedCache>;
  byType?: Map<string, Resolved>;
};
const resolvedCache: ResolvedCache = {};
/**
 * The values class of each node type (see `ResolvedNodeDefinition.Values`),
 * shared by every document: one per document would cost each a few maps.
 */
const valuesClasses = new Map<string, new () => Record<string, string>>();

/**
 * The node definitions of `config`, resolved once for every document with the
 * same ones when their defaults cannot change: documents only read them, and
 * a replica need not keep a copy.
 */
function resolve(config: DocConfig): Resolved {
  const nodeDefs: UnsafeDefinition[] = config.extensions.flatMap(
    (extension) => extension.nodes ?? [],
  );
  let cache = resolvedCache;
  for (const key of [config.crdt?.text ?? resolvedCache, ...nodeDefs]) {
    const next = (cache.next ??= new WeakMap());
    cache = next.get(key) ?? next.set(key, {}).get(key)!;
  }
  const byType = (cache.byType ??= new Map());
  let resolved = byType.get(config.type);
  if (resolved) return resolved;
  const defs = new Set<NodeDefinition>();
  const resolvedDefs = new Map<string, ResolvedNodeDefinition>();
  resolved = [defs, resolvedDefs];
  let mutable = false;
  const RootNode = defineNode({ type: config.type });
  nodeDefs.unshift(RootNode);
  nodeDefs.forEach((nodeDef) => {
    const Values =
      valuesClasses.get(nodeDef.type) ??
      class {
        [key: string]: string;
      };
    valuesClasses.set(nodeDef.type, Values);
    const resolvedNodeDef: ResolvedNodeDefinition = resolvedDefs.get(
      nodeDef.type,
    ) ?? {
      type: nodeDef.type,
      state: {},
      defaultState: {},
      // An instance with every key of the type, each a string first: V8
      // gives the values of stored nodes a slot per key, and lets a slot hold
      // a number without a box of its own.
      defaultStrings: new Values(),
      defaultJson: {},
      methods: undefined as unknown as ResolvedNodeDefinition["methods"],
      Values,
    };

    for (const key in nodeDef.state) {
      const state: InternalStateDefinition = nodeDef.state[key]!;
      // The rules of its first text that has them (see `rulesOfNode`).
      resolvedNodeDef.rules ??= state.rules;
      if (resolvedNodeDef.state[key] !== undefined) {
        throw new Error(
          `Collision error: attempt to register 2 node definitions of type ` +
            `'${nodeDef.type}' that share the state property ${key}. Remove ` +
            `that and any other repeated states in either of the two node definitions.`,
        );
      } else {
        resolvedNodeDef.state[key] = state;
        const defaultState = state.fromJSON(undefined);
        resolvedNodeDef.defaultState[key] = defaultState;
        // An object can change: each document gets its own.
        if (Object(defaultState) === defaultState) mutable = true;
        const defaultJson = state.toJSON
          ? state.toJSON(defaultState)
          : defaultState;
        const stringified = JSON.stringify(defaultJson);
        const copy = jsonCopy(defaultJson);
        if (copy === undefined) {
          throw new Error(
            `JSON serialization of the default value for state '${key}' of node type '${nodeDef.type}' is 'undefined', which is not allowed.`,
          );
        }
        resolvedNodeDef.defaultStrings[key] = stringified;
        resolvedNodeDef.defaultJson[key] = copy;
      }
    }

    resolvedDefs.set(nodeDef.type, resolvedNodeDef);
    defs.add(nodeDef);
    for (const key in nodeDef.state) {
      const definition: InternalStateDefinition = nodeDef.state[key]!;
      const docState = definition.docState;
      const rootDef = resolvedDefs.get(config.type);
      if (!docState || !rootDef || rootDef.state[docState.key]) continue;
      // A CRDT engine brings its own text: the server orders Base's.
      const shared = config.crdt?.text ?? docState.definition;
      resolved[2] = docState.key;
      resolved[3] = shared;
      rootDef.state[docState.key] = shared;
      // Not kept: the default text would be an engine's state, and shared.
      const empty = shared.fromJSON(undefined);
      rootDef.defaultStrings[docState.key] = JSON.stringify(
        shared.toJSON?.(empty),
      );
    }
    if (!nodeDef.type) throw new Error(`Node does not have a type property`);
  });

  resolvedDefs.forEach((resolvedNodeDef) => {
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
  if (!mutable) byType.set(config.type, resolved);
  return resolved;
}
