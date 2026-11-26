import { Doc, type DocConfig, type Operations } from "@docukit/docnode";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Text, TextExtension, nextNodeId } from "./utils.js";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";
const config = { type: "root", extensions: [TextExtension] };

/**
 * Documents loaded while the clock and the random source are frozen: every
 * one gets the same session (the milliseconds since the root was created,
 * then three random characters).
 */
function sameSession<T>(load: () => T): T {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const random = vi
    .spyOn(crypto, "getRandomValues")
    .mockImplementation((array) => array);
  try {
    return load();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The session of the next node id `doc` makes. */
const nextSession = (doc: Doc) => {
  const id = nextNodeId(doc);
  return id.slice(0, id.lastIndexOf("."));
};

/** A replica that records what it writes, with the inverses to undo it. */
function replica(doc: Doc) {
  const sent: { operations: Operations; inverse: Operations }[] = [];
  let receiving = false;
  doc.onChange((event) => {
    if (receiving) return;
    sent.push({
      operations: event.operations,
      inverse: event.inverseOperations,
    });
  });
  const write = (...values: string[]) => {
    for (const value of values) {
      const node = doc.createNode(Text);
      node.state.value.set(value);
      doc.root.append(node);
    }
    doc.forceCommit();
  };
  const apply = (operations: Operations) => {
    receiving = true;
    doc.applyOperations(operations, { skipUndo: true });
    doc.forceCommit();
    receiving = false;
  };
  return { doc, sent, write, apply };
}

type Replica = ReturnType<typeof replica>;

/**
 * What a server that orders changes gives (DocSync with Base): `first`'s
 * changes go first. `first` applies `second`'s on top; `second` undoes its
 * own with their inverses, applies `first`'s and redoes its own.
 */
function serverOrder(first: Replica, second: Replica) {
  for (const { operations } of second.sent) first.apply(operations);
  for (const { inverse } of [...second.sent].reverse()) second.apply(inverse);
  for (const { operations } of first.sent) second.apply(operations);
  for (const { operations } of second.sent) second.apply(operations);
  first.sent.length = 0;
  second.sent.length = 0;
}

const values = (doc: Doc) => {
  const out: string[] = [];
  doc.root.children().forEach((node) => {
    if (node.is(Text)) out.push(node.state.value.get());
  });
  return out;
};

describe("two replicas with the same session", () => {
  test("nodes: the one that receives an id it did not make yet takes a new session, and in server order both converge", () => {
    const base = new Doc({ ...config, id: ROOT_ID });
    base.forceCommit();
    const json = base.toJSON();
    const [a, b] = sameSession(() => [
      replica(Doc.fromJSON(config, json)),
      replica(Doc.fromJSON(config, json)),
    ]);
    const session = sameSession(() => nextSession(Doc.fromJSON(config, json)));
    a.write("from a");
    b.write("from b", "b again");
    serverOrder(a, b);
    // a received `session.1`, which it never made: it took a new session.
    expect(nextSession(a.doc)).not.toBe(session);
    expect(nextSession(b.doc)).toBe(session);
    // What collided: `session.0` keeps the place a gave it and the state b
    // wrote last. a's value is lost, as Yjs loses the first edit that collided.
    expect(values(a.doc)).toStrictEqual(["from b", "b again"]);
    expect(values(b.doc)).toStrictEqual(values(a.doc));
    // What both write next no longer collides.
    a.write("a later");
    b.write("b later");
    serverOrder(a, b);
    expect(values(a.doc)).toStrictEqual([
      "from b",
      "b again",
      // b appended after the last node it saw.
      "b later",
      "a later",
    ]);
    expect(b.doc.toJSON()).toStrictEqual(a.doc.toJSON());
  });

  test("with its own id generator, a document keeps its session: it has no other to take", () => {
    const sameIds = (): DocConfig => {
      let clock = 0;
      return {
        ...config,
        nodeIdGenerator: {
          generate: () => `same.${clock++}`,
          validate: () => true,
        },
      };
    };
    const base = new Doc({ ...sameIds(), id: ROOT_ID });
    base.forceCommit();
    const json = base.toJSON();
    const a = replica(Doc.fromJSON(sameIds(), json));
    const b = replica(Doc.fromJSON(sameIds(), json));
    a.write("from a");
    b.write("from b", "b again");
    for (const { operations } of b.sent) a.apply(operations);
    expect(nextSession(a.doc)).toBe("same");
  });
});
