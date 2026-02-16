import type { DocNode } from "@docukit/docnode";

export const descendants = {
  customToArray: function (docnode: DocNode, includeSelf = false) {
    const array: DocNode[] = [];
    // prettier-ignore
    this.custom(docnode, (node) => { array.push(node) }, includeSelf);
    return array;
  },
  generator: function* (docnode: DocNode, includeSelf = false) {
    const self = docnode;
    function* traverse(node: DocNode | undefined): IterableIterator<DocNode> {
      let current = node;
      while (current) {
        yield current;
        yield* traverse(current.first);
        current = current.next;
      }
    }
    if (includeSelf) yield docnode;
    yield* traverse(self.first);
  },
  iteratorClass: function (docnode: DocNode, includeSelf = false) {
    return new DescendantIterator(docnode, includeSelf);
  },
  custom: function (
    docnode: DocNode,
    callback: (node: DocNode) => void,
    includeSelf = false,
  ) {
    const traverse = (node: DocNode | undefined): void => {
      let current = node;
      while (current) {
        callback(current);
        traverse(current.first);
        current = current.next;
      }
    };

    if (includeSelf) callback(docnode);
    traverse(docnode.first);
  },
  customDeepLevel: (
    docnode: DocNode,
    callback: (node: DocNode, deepLevel: number) => void,
    includeSelf = false,
  ) => {
    const traverse = (node: DocNode | undefined, deepLevel: number): void => {
      let current = node;
      while (current) {
        callback(current, deepLevel);
        traverse(current.first, deepLevel + 1);
        current = current.next;
      }
    };
    if (includeSelf) callback(docnode, 0);
    traverse(docnode.first, 1);
  },
  customPath: (
    docnode: DocNode,
    callback: (node: DocNode, path: number[]) => void,
    includeSelf = false,
  ) => {
    const traverse = (node: DocNode | undefined, path: number[]): void => {
      let current = node;
      let index = 0;

      while (current) {
        path.push(index);
        callback(current, path);
        traverse(current.first, path);
        path.pop();

        current = current.next;
        index++;
      }
    };
    if (includeSelf) callback(docnode, []);
    traverse(docnode.first, []);
  },
  customStack: function (
    docnode: DocNode,
    callback: (node: DocNode) => void,
    includeSelf = false,
  ) {
    const stack: DocNode[] = [];
    if (includeSelf) stack.push(docnode);
    if (docnode.first) stack.push(docnode.first);

    while (stack.length > 0) {
      const node = stack.pop()!;
      callback(node);
      if (node.next) stack.push(node.next);
      if (node.first) stack.push(node.first);
    }
  },
};

class DescendantIterator extends Iterator<DocNode> {
  private _stack: DocNode[];

  constructor(docnode: DocNode, includeSelf = false) {
    super();
    this._stack = [];
    if (includeSelf) this._stack.push(docnode);
    if (docnode.first) this._stack.push(docnode.first);
  }

  override next(): IteratorResult<DocNode> {
    if (this._stack.length === 0) {
      return { done: true, value: undefined };
    }

    const node = this._stack.pop()!;
    if (node.next) this._stack.push(node.next);
    if (node.first) this._stack.push(node.first);

    return { done: false, value: node };
  }
}

export const children = {
  customToArray: function (docnode: DocNode, includeSelf = false) {
    const array: DocNode[] = [];
    this.custom(
      docnode,
      (node) => {
        array.push(node);
      },
      includeSelf,
    );
    return array;
  },
  custom: function (
    docnode: DocNode,
    callback: (node: DocNode) => void,
    includeSelf = false,
  ) {
    if (includeSelf) callback(docnode);
    let current = docnode.first;
    while (current) {
      callback(current);
      current = current.next;
    }
  },
  generator: function* (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.first;
    while (current) {
      yield current;
      current = current.next;
    }
  },
  iteratorClass: function (docnode: DocNode, includeSelf = false) {
    return new ChildrenIterator(docnode, includeSelf);
  },
  iteratorInline: function (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.first;

    const iterator = {
      next(): IteratorResult<DocNode> {
        if (!current) {
          return { done: true, value: undefined };
        }
        const value = current;
        current = current.next;
        return { done: false, value };
      },
      [Symbol.iterator]() {
        return this;
      },
    };

    // Add forEach method for compatibility
    return Object.assign(iterator, {
      forEach(callback: (value: DocNode) => void) {
        let result = iterator.next();
        while (!result.done) {
          callback(result.value);
          result = iterator.next();
        }
      },
    });
  },
};

/**
 * Basically the same as NextSiblingsIterator but next() needs
 * to check includeSelf in each call.
 */
class ChildrenIterator extends Iterator<DocNode> {
  private _current: DocNode | undefined;
  private _toFirst: boolean;

  constructor(node: DocNode, includeSelf = false) {
    super();
    this._current = includeSelf ? node : node.first;
    this._toFirst = includeSelf;
  }

  override next(): IteratorResult<DocNode> {
    if (!this._current) {
      return { done: true, value: undefined };
    }
    if (this._toFirst) {
      this._toFirst = false;
      const first = this._current.first;
      if (!first) return { done: true, value: undefined };
      this._current = first; // Fix: Update _current to point to the first child
      return { done: false, value: first };
    }
    const value = this._current;
    this._current = this._current.next;
    return { done: false, value };
  }
}

class NextSiblingsIterator extends Iterator<DocNode> {
  private _current: DocNode | undefined;

  constructor(node: DocNode) {
    super();
    this._current = node.next;
  }

  override next(): IteratorResult<DocNode> {
    if (!this._current) {
      return { done: true, value: undefined };
    }
    const value = this._current;
    this._current = this._current.next;
    return { done: false, value };
  }
}

class NextSiblingsIterator2 extends Iterator<DocNode> {
  private _nextResult: { done: boolean; value: DocNode | undefined };

  constructor(node: DocNode) {
    super();
    this._nextResult = { done: false, value: node.next };
  }

  override next(): IteratorResult<DocNode> {
    if (!this._nextResult.value) {
      this._nextResult.done = true;
      this._nextResult.value = undefined;
      return this._nextResult as IteratorResult<DocNode>;
    }
    this._nextResult.value = this._nextResult.value.next;
    return this._nextResult as IteratorResult<DocNode>;
  }
}

export const nextSiblings = {
  customToArray: function (docnode: DocNode, includeSelf = false) {
    const array: DocNode[] = [];
    this.custom(docnode, includeSelf).forEach((node) => {
      array.push(node);
    });
    return array;
  },
  generator: function* (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.next;
    while (current) {
      yield current;
      current = current.next;
    }
  },
  iteratorClass: function (docnode: DocNode) {
    return new NextSiblingsIterator(docnode);
  },
  iteratorClass2: function (docnode: DocNode) {
    return new NextSiblingsIterator2(docnode);
  },
  iteratorsetPrototype: function (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.next;
    const iterator = {
      next() {
        if (!current) {
          return { done: true, value: undefined };
        }
        const value = current;
        current = current.next;
        return { done: false, value };
      },
    };
    Object.setPrototypeOf(iterator, Iterator.prototype);
    return iterator as IteratorObject<DocNode>;
  },
  iteratorCreateObject: function (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.next;
    return Object.create(Iterator.prototype, {
      next: {
        value: function () {
          if (!current) {
            return { done: true, value: undefined };
          }
          const value = current;
          current = current.next;
          return { done: false, value };
        },
      },
    }) as IteratorObject<DocNode>;
  },

  iteratorInline: function (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.next;

    const iterator = {
      next(): IteratorResult<DocNode> {
        if (!current) {
          return { done: true, value: undefined };
        }
        const value = current;
        current = current.next;
        return { done: false, value };
      },
      [Symbol.iterator]() {
        return this;
      },
    };

    // Add forEach method for compatibility
    return Object.assign(iterator, {
      forEach(callback: (value: DocNode) => void) {
        let result = iterator.next();
        while (!result.done) {
          callback(result.value);
          result = iterator.next();
        }
      },
    });
  },
  custom: function (docnode: DocNode, includeSelf = false) {
    let current = includeSelf ? docnode : docnode.next;

    return {
      forEach(callback: (value: DocNode) => void) {
        while (current) {
          callback(current);
          current = current.next;
        }
      },
    };
  },
  iteratorManual: function (node: DocNode) {
    let cur: DocNode | undefined = node.next;

    const it: IterableIterator<DocNode> = {
      next(): IteratorResult<DocNode, undefined> {
        if (!cur) {
          return { done: true as const, value: undefined };
        }
        const value = cur;
        cur = cur.next;
        return { done: false as const, value };
      },
      [Symbol.iterator]() {
        return this;
      },
    };

    return Iterator.from(it);
  },
};
