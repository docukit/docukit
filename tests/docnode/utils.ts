import {
  Doc,
  type ChangeEvent,
  type DocNode,
  defineNode,
  type Operations,
  defineState,
  type Extension,
} from "docnode";
import { boolean, number, string } from "docnode";
import { type Diff, type JsonDoc } from "docnode";
import { UndoManager } from "docnode";
import { ULID_REGEX } from "valibot";
import { expect } from "vitest";

export const DOCNODE_ID = (sessionId = "[\\w-]", clockId = "[\\w-]") =>
  new RegExp(`^${sessionId}[\\w-]{3}\\.${clockId}$`);

export const date = (defaultValue: Date) =>
  defineState({
    fromJSON: (json) =>
      typeof json === "string" ? new Date(json) : defaultValue,
    // toJSON: (date) => date.toISOString(),
  });

export const Text = defineNode({
  type: "text",
  state: {
    value: string(""),
  },
});

export const TextExtension: Extension = {
  nodes: [Text],
};

export const TestNode = defineNode({
  type: "test",
  state: {
    string: string(""),
    number: number(0),
    boolean: boolean(false),
    date: date(new Date(0)),
  },
});

export const TestExtension: Extension = {
  nodes: [TestNode],
};

export const text = (doc: Doc, ...values: string[]) =>
  values.map((value) => {
    const node = doc.createNode(Text);
    node.state.value.set(value);
    return node;
  });

function getStateSnapshot(doc: Doc, isTestNode = true): unknown[] {
  let count = 1;
  const state: unknown[] = [];
  doc.root.descendants().forEach((node, deepLevel) => {
    count++;
    if (node.prev) expect(node.prev.next).toBe(node);
    else if (node.parent) expect(node.parent.first).toBe(node);
    if (node.next) expect(node.next.prev).toBe(node);
    else if (node.parent) expect(node.parent.last).toBe(node);
    if (node.first) expect(node.first.parent).toBe(node);
    if (node.last) expect(node.last.parent).toBe(node);
    if (isTestNode) {
      const item = `${"__".repeat(deepLevel - 1)}${(node as DocNode<typeof Text>).state.value.get()}`;
      state.push(item);
    } else {
      state.push(node.toJSON()[2]);
    }
  });
  expect(count).toBe(doc["_nodeMap"].size);
  return state;
}

export function assertDoc(doc: Doc, expectedState: string[]) {
  expect(getStateSnapshot(doc, true)).toStrictEqual(expectedState);
}

type JsonWithoutId = [
  type: string,
  state: Record<string, string>,
  children?: [JsonWithoutId, ...JsonWithoutId[]],
];

export function prettifyJson(doc: JsonDoc): JsonWithoutId {
  const children = doc[3]?.map(prettifyJson) as
    | [JsonWithoutId, ...JsonWithoutId[]]
    | undefined;
  return children ? [doc[1], doc[2], children] : [doc[1], doc[2]];
}

export function assertJson(doc: Doc, expected: JsonWithoutId) {
  const json = prettifyJson(doc.toJSON({ unsafe: true }));
  expect(json).toStrictEqual(expected);
}

export function init(
  fn: (ctx: {
    doc: Doc;
    root: DocNode;
    node1: DocNode<typeof Text>;
    node2: DocNode<typeof Text>;
    node3: DocNode<typeof Text>;
    node4: DocNode<typeof Text>;
  }) => void,
) {
  const doc = new Doc({ extensions: [TextExtension] });
  const { root } = doc;
  checkUndoManager(1, doc, () => {
    root.append(...text(doc, "1", "2", "3", "4"));
    const node1 = root.first! as DocNode<typeof Text>;
    const node2 = node1.next! as DocNode<typeof Text>;
    const node3 = node2.next! as DocNode<typeof Text>;
    const node4 = node3.next! as DocNode<typeof Text>;
    fn({ doc, root, node1, node2, node3, node4 });
  });
}

export function humanReadableOperations(doc: Doc, changeEvent: ChangeEvent) {
  const { diff } = changeEvent;
  const id = (id: string | 0) => {
    if (!id) return "undefined";
    const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
    if (ULID.test(id)) return "ROOT";
    const node = doc.getNodeById(id);
    if (!node) {
      const jsonState = diff.deleted.get(id)?.toJSON()[2];
      if (jsonState) {
        const { value } = jsonState as { value: string };
        if (!value) return "❌UNDEFINED";
        return JSON.parse(value) as string;
      }
      return `❌${id.slice(-4)}`;
    } else if ((node as DocNode<typeof Text>).state.value) {
      return (node as DocNode<typeof Text>).state.value.get();
    } else {
      return JSON.stringify(node.toJSON()[2]);
    }
  };

  const processOperations = (operations: Operations) => {
    const humanReadableOperations = [];
    for (const operation of operations[0]) {
      switch (operation[0]) {
        case 0: {
          const values: string[] = [];
          operation[1].forEach((jsonNode) => {
            values.push(id(jsonNode[0]));
          });
          const parent = operation[2] ? id(operation[2]) : "ROOT";
          const prev = id(operation[3]);
          const next = id(operation[4]);
          humanReadableOperations.push(
            `INSERT: ${prev} --> ${values.join(" - ")} <-- ${next} | PARENT: ${parent}`,
          );
          break;
        }
        case 1: {
          const start = id(operation[1]);
          const end = id(operation[2] || operation[1]);
          humanReadableOperations.push(`DELETE: from ${start} to ${end}`);
          break;
        }
        case 2: {
          const start = id(operation[1]);
          const end = id(operation[2] || operation[1]);
          const parent = operation[3] ? id(operation[3]) : "ROOT";
          const prev = id(operation[4]);
          const next = id(operation[5]);
          humanReadableOperations.push(
            `MOVE: ${start} - ${end} | Parent: ${parent} | Prev: ${prev} | Next: ${next}`,
          );
          break;
        }
        default:
          operation satisfies never;
      }
    }
    const statePatch = operations[1];
    const readableStatePatch = Object.fromEntries(
      Object.entries(statePatch).map(([k, v]) => {
        return [
          id(k),
          Object.fromEntries(
            Object.entries(v).map(([k, v]) => [
              k,
              JSON.parse(v ?? '"❌UNDEFINED"'),
            ]),
          ),
        ];
      }),
    );
    if (Object.keys(readableStatePatch).length > 0) {
      humanReadableOperations.push(
        `UPDATE: ${JSON.stringify(readableStatePatch)}`,
      );
    }
    return humanReadableOperations;
  };
  const newDiff: Omit<Diff, "deleted"> & {
    deleted: Record<string, JsonWithoutId>;
  } = {
    inserted: new Set([...diff.inserted].map(id)),
    deleted: Object.fromEntries(
      [...diff.deleted].map(([k, v]) => {
        const [_id, ...rest] = v.toJSON();
        return [id(k), rest];
      }),
    ),
    moved: new Set([...diff.moved].map(id)),
    updated: new Set([...diff.updated].map(id)),
  };
  return {
    operations: processOperations(changeEvent.operations),
    inverseOperations: processOperations(changeEvent.inverseOperations),
    diff: newDiff,
  };
}

function listen(
  doc: Doc,
  fn: () => void,
  onChangeFn: (changeEvent: ChangeEvent) => void,
) {
  doc.forceCommit();
  const unregister = doc.onChange(onChangeFn);
  fn();
  doc.forceCommit();
  unregister();
}

export function updateAndListen(
  doc: Doc,
  updateFn: () => void,
  onChangeFn: (changeEvent: ChangeEvent) => void,
) {
  let count = 0;
  listen(
    doc,
    () => {
      count++;
      updateFn();
    },
    onChangeFn,
  );
  expect(count).toBe(1);
}

export function emptyUpdate(doc: Doc, fn: () => void) {
  let count = 0;
  doc.forceCommit();
  const unregister = doc.onChange(() => {
    count++;
  });
  fn();
  doc.forceCommit();
  expect(count).toBe(0);
  unregister();
}

export function assertError(doc: Doc, fn: () => void, expectedError: string) {
  doc.forceCommit();
  let txCount = 0;
  const snapshot = getStateSnapshot(doc);
  const unregister = doc.onChange(() => {
    txCount++;
  });
  expect(fn).toThrowError(expectedError);
  doc.forceCommit();
  expect(getStateSnapshot(doc)).toStrictEqual(snapshot);
  expect(txCount).toBe(0);
  unregister();
}

export function checkUndoManager(
  txCount: number,
  doc: Doc,
  callback: () => void,
) {
  const IS_TEST_NODE = false;
  const jsonDoc = doc.toJSON();
  const nodes = Array.from(doc["_nodeDefs"]);
  // This document will replay all doc operations in a single update
  const doc2 = Doc.fromJSON({ extensions: [{ nodes }] }, jsonDoc);
  const undoManager2 = new UndoManager(doc2, { maxUndoSteps: 1 });

  // This document will replay all doc operations in different updates
  const doc3 = Doc.fromJSON({ extensions: [{ nodes }] }, jsonDoc);
  const undoManager3 = new UndoManager(doc3, { maxUndoSteps: 10000000 });

  const changeEvents: ChangeEvent[] = [];
  const snapshots: unknown[] = [getStateSnapshot(doc, IS_TEST_NODE)];
  const jsonDocs: JsonDoc[] = [jsonDoc];
  let sizeDo = 0;

  // 1. DO
  listen(doc, callback, (changeEvent) => {
    sizeDo++;
    expect(changeEvent).not.toStrictEqual(changeEvents.at(-1));
    changeEvents.push(changeEvent);

    const snapshot = getStateSnapshot(doc, IS_TEST_NODE);
    expect(snapshot).not.toStrictEqual(snapshots.at(-1));
    snapshots.push(snapshot);

    const jsonDoc = doc.toJSON();
    expect(jsonDoc).not.toStrictEqual(jsonDocs.at(-1));
    jsonDocs.push(jsonDoc);

    // TESTS OVER OPERATIONS AND DIFF
    // Operations need to be json serializable
    expect(
      JSON.parse(JSON.stringify(changeEvent.inverseOperations)),
    ).toStrictEqual(changeEvent.inverseOperations);
    expect(JSON.parse(JSON.stringify(changeEvent.operations))).toStrictEqual(
      changeEvent.operations,
    );

    const { operations, inverseOperations, diff } = changeEvent;
    const allOperations = [...operations[0], ...inverseOperations[0]];
    allOperations.forEach((op) => {
      switch (op[0]) {
        case 0: {
          // INSERT
          const [, nodes, parent, prev, next] = op;
          expect(nodes).toBeInstanceOf(Array);
          nodes.forEach((insertTuple: [string, string]) => {
            expect(insertTuple[0]).toMatch(DOCNODE_ID());
            expect(typeof insertTuple[1]).toBe("string");
            expect(insertTuple[1]).not.toBe("root");
          });
          if (parent !== 0) expect(parent).toMatch(DOCNODE_ID());
          if (prev !== 0) expect(prev).toMatch(DOCNODE_ID());
          if (next !== 0) expect(next).toMatch(DOCNODE_ID());
          break;
        }
        case 1: {
          // DELETE
          const [, start, end] = op;
          expect(start).toMatch(DOCNODE_ID());
          if (end !== 0) expect(end).toMatch(DOCNODE_ID());
          expect(start).not.toBe(end);
          break;
        }
        case 2: {
          // MOVE
          const [, start, end, parent, prev, next] = op;
          expect(start).toMatch(DOCNODE_ID());
          if (end !== 0) expect(end).toMatch(DOCNODE_ID());
          if (parent !== 0) expect(parent).toMatch(DOCNODE_ID());
          if (prev !== 0) expect(prev).toMatch(DOCNODE_ID());
          if (next !== 0) expect(next).toMatch(DOCNODE_ID());
          expect(start).not.toBe(end);
          break;
        }
        default:
          throw new Error(`Unknown operation type: ${op[0] as number}`);
      }
    });

    diff.updated.forEach((id) => {
      expect(DOCNODE_ID().test(id) || ULID_REGEX.test(id)).toBe(true);
      expect(doc.getNodeById(id)).toBeDefined();
      expect(diff.inserted.has(id)).toBe(false);
      // A node can be in diff.updated and diff.moved at the same time
      // expect(diff.moved.has(id)).toBe(false);
      expect(diff.deleted.has(id)).toBe(false);
      expect(operations[1][id]).toBeDefined();
      expect(inverseOperations[1][id]).toBeDefined();
    });
    diff.inserted.forEach((id) => {
      expect(id).toMatch(DOCNODE_ID());
      expect(doc.getNodeById(id)).toBeDefined();
      expect(diff.moved.has(id)).toBe(false);
      expect(diff.deleted.has(id)).toBe(false);
    });
    diff.moved.forEach((id) => {
      expect(doc.getNodeById(id)).toBeDefined();
      expect(id).toMatch(DOCNODE_ID());
      expect(diff.deleted.has(id)).toBe(false);
    });
    diff.deleted.keys().forEach((id) => {
      expect(id).toMatch(DOCNODE_ID());
      expect(doc.getNodeById(id)).toBeUndefined();
    });
    for (const id in operations[1]) {
      if (!diff.inserted.has(id)) expect(diff.updated.has(id)).toBe(true);
    }
    for (const id in inverseOperations[1]) {
      if (!diff.deleted.has(id)) expect(diff.updated.has(id)).toBe(true);
    }

    // getPrev should change for updated nodes and only for those
    // TODO: later I could include non Text nodes.
    diff.updated.forEach((id) => {
      const node = doc.getNodeById(id)!;
      if (!node.is(Text)) return;
      expect(node.state.value.getPrev()[0]).toBe(true);
    });
    doc["_nodeMap"].forEach((node) => {
      if (diff.updated.has(node.id)) {
        expect(operations[1][node.id]).toBeDefined();
      } else if (!diff.inserted.has(node.id)) {
        expect(operations[1][node.id]).toBeUndefined();
      }
      if (!node.is(Text) || diff.updated.has(node.id)) return;
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });
  expect(sizeDo).toBe(txCount);

  // 2. REPLAY IN A SINGLE UPDATE (doc2)
  updateAndListen(
    doc2,
    () => {
      for (const changeEvent of changeEvents) {
        doc2.applyOperations(changeEvent.operations);
      }
    },
    (changeEvent) => {
      expect(changeEvent.operations.length).toBe(2); // A single op array + state patch
      // The array of operations is equal to the conjunction of all those that were in changeEvents
      // slice(0, -1) because the last operation is the state patch
      expect(changeEvent.operations[0]).toStrictEqual(
        changeEvents.map((ev) => ev.operations.slice(0, -1)).flat(2),
      );
      // Inverse operations can't be compared. The following isn't always true because if a node
      // is inserted in one update and its child is inserted in the next update, inverseOperations
      // will have only one delete op (the parent's) instead of the two I get when doing separate updates.
      // expect(changeEvent.inverseOperations[0]).toStrictEqual(
      //   changeEvents.map((ev) => ev.inverseOperations.slice(0, -1)).flat(2),
      // );
    },
  );
  expect(doc2.toJSON()).toStrictEqual(doc.toJSON());
  expect(getStateSnapshot(doc2, IS_TEST_NODE)).toStrictEqual(snapshots.at(-1));
  undoManager2.undo();
  expect(getStateSnapshot(doc2, IS_TEST_NODE)).toStrictEqual([]);

  // 3. REPLAY IN DIFFERENT UPDATES (doc3)
  for (const [i, changeEvent] of changeEvents.entries()) {
    updateAndListen(
      doc3,
      () => {
        doc3.applyOperations(changeEvent.operations);
      },
      (changeEvent) => {
        expect(doc3.toJSON()).toStrictEqual(jsonDocs[i + 1]);
        expect(getStateSnapshot(doc3, IS_TEST_NODE)).toStrictEqual(
          snapshots[i + 1],
        );
        expect(changeEvent).toStrictEqual(changeEvents[i]);
      },
    );
  }

  // 4. UNDO
  for (let i = 0; i < sizeDo; i++) {
    listen(
      doc3,
      () => {
        undoManager3.undo();
        const snapshot = getStateSnapshot(doc3, IS_TEST_NODE);
        expect(snapshot).toStrictEqual(snapshots[sizeDo - i - 1]);
        const jsonDoc = doc3.toJSON();
        expect(jsonDoc).toStrictEqual(jsonDocs[sizeDo - i - 1]);
      },
      (_changeEvent) => {
        // The first undo coincides with the first do
        // expect(changeEvent.operations).toStrictEqual(
        //   changeEvents.at(sizeDo - i - 1)?.inverseOperations,
        // );
        // This cannot be compared either. Since operations are executed in reverse,
        // an insertion in undo could have, for example, siblings that it did not have
        // at the time of the insertion in do.
        // expect(changeEvent.inverseOperations).toStrictEqual(
        //   changeEvents.at(sizeDo - i - 1)?.operations,
        // );
      },
    );
  }

  // 5. REDO
  for (let i = 0; i < sizeDo; i++) {
    listen(
      doc3,
      () => {
        undoManager3.redo();
        const snapshot = getStateSnapshot(doc3, IS_TEST_NODE);
        expect(snapshot).toStrictEqual(snapshots[i + 1]);
        const jsonDoc = doc3.toJSON();
        expect(jsonDoc).toStrictEqual(jsonDocs[i + 1]);
      },
      (_changeEvent) => {
        // expect(changeEvent).toStrictEqual(changeEvents[i]);
      },
    );
  }
}

export const getPrevError = [
  "getPrev cannot be used on nodes that are not attached or that",
  "have been inserted in the current transaction. Usually, you",
  "will want to use getPrev with nodes from diff.updated.",
].join(" ");

// not used anywhere. Written here just in case I need it later.
export const sessionSort = (a: string, b: string): number => {
  a = a.split(".")[0]!.padStart(12, "z");
  b = b.split(".")[0]!.padStart(12, "z");
  return a > b ? 1 : a < b ? -1 : 0;
};
