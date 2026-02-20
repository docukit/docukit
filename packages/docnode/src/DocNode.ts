import {
  type IntersectionOf,
  type JsonDocNode,
  type NodeDefinition,
  type IterableOptions,
  type UnsafeDefinition,
  type Find,
  type NodeState,
} from "./types.js";
import { detachRange, withTransaction } from "./utils.js";
import * as operations from "./operations.js";
import type { Doc } from "./Doc.js";

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
  readonly doc!: Doc;

  private constructor(doc: Doc, type: string, id?: string) {
    this.type = type;
    this._state = {};
    this.id = id ?? doc["_nodeIdGenerator"](doc);
    Object.defineProperty(this, "doc", {
      enumerable: false,
      value: doc,
      writable: false,
    });
  }

  /**
   * Attaches the node relative to the parent, prev, and next,
   * but does not necessarily attach it to the doc (this happens
   * if the parent is not attached to the document)
   */
  private _attachNode(config: {
    parent: DocNode;
    prev?: DocNode | undefined;
    next?: DocNode | undefined;
  }) {
    const isParentAttached = config.parent?.doc["_nodeMap"].has(
      config.parent.id,
    );
    if (isParentAttached) {
      const map = this.doc["_nodeMap"];
      this.descendants({ includeSelf: true }).forEach((node) => {
        map.set(node.id, node);
      });
    }
    this._set("parent", config.parent);
    this._set("prev", config.prev);
    this._set("next", config.next);
    return this;
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
          operations.onDeleteRange(this.doc, this, laterSibling);
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
          let isTargetDescendantOfRange = false;
          target.ancestors().forEach((ancestor) => {
            if (nodes.has(ancestor)) isTargetDescendantOfRange = true;
          });
          if (isTargetDescendantOfRange)
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
          operations.onMoveRange(
            doc,
            this,
            laterSibling,
            newParent,
            newPrev,
            newNext,
          );

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
              const stringified = operations.stringifyStateKey(node, key);
              const parsed = operations.parseStateKey(
                newNode,
                key,
                stringified,
              );
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
    return [this.id, this.type, this._stateToJson()];
  }

  private _stateToJson(): NodeState.Stringified<T> {
    const jsonState: Record<string, string> = {};
    const resolvedNodeDef = this.doc["_resolvedNodeDefs"].get(this.type);
    const defaultString = resolvedNodeDef?.defaultStrings;
    for (const key in this._state) {
      const stringifiedState = operations.stringifyStateKey(this, key);
      if (stringifiedState === defaultString?.[key]) continue;
      const stateDefinition = resolvedNodeDef?.state[key];
      const json = stateDefinition?.toJSON
        ? stateDefinition.toJSON(this._state[key])
        : this._state[key];
      jsonState[key] = JSON.stringify(json);
    }
    return jsonState as NodeState.Stringified<T>;
  }
}
