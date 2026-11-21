import {
  Doc,
  type DocConfig,
  type Operations,
  type TextHandle,
} from "@docukit/docnode";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Text, TextExtension } from "./utils.js";
import { Paragraph, config as textConfig } from "./text/utils.js";
import { defaultConfig as baseConfig, rootText } from "./baseText/utils.js";

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
  const id = doc["_nodeIdGenerator"](doc);
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

const apply = (doc: Doc, operations: Operations) => {
  doc.applyOperations(operations, { skipUndo: true });
  doc.forceCommit();
};

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

/**
 * Two replicas of paragraphs "ab" and "xy" with the same session, from their
 * own generator: it never changes, so what they write keeps colliding.
 */
function collidedTexts() {
  const config = () => textConfig(false, "same");
  const base = new Doc({ ...textConfig(false, "base"), id: ROOT_ID });
  const add = (text: string) => {
    const paragraph = base.createNode(Paragraph);
    base.root.append(paragraph);
    paragraph.state.t.insert(0, text);
    return paragraph.id;
  };
  const first = add("ab");
  const second = add("xy");
  base.forceCommit();
  const json = base.toJSON();
  const edit = (doc: Doc, id: string, write: (text: TextHandle) => void) => {
    const sent: Operations[] = [];
    const off = doc.onChange((event) => sent.push(event.operations));
    const node = doc.getNodeById(id);
    if (node?.is(Paragraph)) write(node.state.t);
    doc.forceCommit();
    off();
    return sent;
  };
  /** The spans of both paragraphs in a reload of `doc`. */
  const read = (doc: Doc) => {
    const reloaded = Doc.fromJSON(
      { ...textConfig(), id: doc.root.id },
      doc.toJSON(),
    );
    return [first, second].map((id) => {
      const node = reloaded.getNodeById(id);
      return node?.is(Paragraph) ? node.state.t.spans() : [];
    });
  };
  const a = Doc.fromJSON({ ...config(), id: base.root.id }, json);
  const b = Doc.fromJSON({ ...config(), id: base.root.id }, json);
  return { a, b, first, second, edit, read };
}

/** Ids `same.<clock>` from a generator of the document's own: no time part. */
const sameIdsOf = () => {
  let clock = 0;
  return {
    nodeIdGenerator: {
      generate: () => `same.${clock++}`,
      validate: () => true,
    },
  };
};

describe("two replicas with the same session", () => {
  test("nodes: the one that receives an id it did not make yet takes a new session, and in server order both converge", () => {
    const base = new Doc({ ...config, id: ROOT_ID });
    base.forceCommit();
    const json = base.toJSON();
    const [a, b] = sameSession(() => [
      replica(Doc.fromJSON({ ...config, id: base.root.id }, json)),
      replica(Doc.fromJSON({ ...config, id: base.root.id }, json)),
    ]);
    const session = sameSession(() =>
      nextSession(Doc.fromJSON({ ...config, id: base.root.id }, json)),
    );
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

  test("text: letters it did not write yet make it take a new session; what collided stays apart", () => {
    const base = new Doc({ ...textConfig(), id: ROOT_ID });
    const paragraph = base.createNode(Paragraph);
    base.root.append(paragraph);
    base.forceCommit();
    const json = base.toJSON();
    const [a, b] = sameSession(() => [
      Doc.fromJSON({ ...textConfig(), id: base.root.id }, json),
      Doc.fromJSON({ ...textConfig(), id: base.root.id }, json),
    ]);
    const type = (doc: Doc, text: string) => {
      const sent: Operations[] = [];
      const off = doc.onChange((event) => sent.push(event.operations));
      const node = doc.getNodeById(paragraph.id);
      if (node?.is(Paragraph))
        node.state.t.insert(node.state.t.get().length, text);
      doc.forceCommit();
      off();
      return sent;
    };
    const text = (doc: Doc) => {
      const node = doc.getNodeById(paragraph.id);
      return node?.is(Paragraph) ? node.state.t.get() : "";
    };
    const fromA = type(a, "ab");
    const fromB = type(b, "xyz");
    const session = nextSession(b);
    // Text operations need no order: each one gets the other's.
    for (const operations of fromB) apply(a, operations);
    for (const operations of fromA) apply(b, operations);
    // a received a letter past its own: it took a new session. b only got
    // letters it had written itself, so it cannot tell.
    expect(nextSession(a)).not.toBe(session);
    // What collided: the letters with the same ids. Each replica keeps its
    // own and skips the other's; a also gets the letter past its own.
    expect(text(a)).toBe("abz");
    expect(text(b)).toBe("xyz");
    // Letters typed again with the same counters are also skipped: a
    // replica's own ones are behind its counter.
    for (const operations of fromA) apply(a, operations);
    expect(text(a)).toBe("abz");
    // What a writes next is of its new session, so b gets it.
    const later = type(a, "!");
    for (const operations of later) apply(b, operations);
    expect(text(b)).toBe("xyz!");
  });
  test("text: a replica reloaded after a collision still reads its text", () => {
    const { a, b, first, second, edit, read } = collidedTexts();
    const bold = edit(b, second, (t) => t.insert(2, "bc", { bold: true }));
    const link = edit(a, first, (t) => t.format(0, 1, "link", "u0"));
    for (const operations of bold) apply(a, operations);
    const typed = edit(a, second, (t) => t.insert(3, "a"));
    for (const operations of [...link, ...typed]) apply(b, operations);
    // The same ids name different letters, and on b the origins of some
    // letters form a cycle. Reading the attributes after a reload followed
    // it until memory ran out.
    const bc = { text: "bc", attrs: { bold: true } };
    const linked = [
      { text: "a", attrs: { link: "u0" } },
      { text: "b", attrs: {} },
    ];
    expect(read(b)).toStrictEqual([linked, [{ text: "xy", attrs: {} }, bc]]);
    // What collided stays apart: a has its "a" between b's letters.
    expect(read(a)).toStrictEqual([
      linked,
      [
        { text: "xy", attrs: {} },
        { text: "b", attrs: { bold: true } },
        { text: "a", attrs: {} },
        { text: "c", attrs: { bold: true } },
      ],
    ]);
  });

  test("text: a reload reads a text whose origin is in a text it has not read yet", () => {
    const { a, b, first, second, edit, read } = collidedTexts();
    const bold = edit(b, second, (t) => t.insert(1, "bc", { bold: true }));
    const typed = edit(a, first, (t) => t.insert(1, "a"));
    const deleted = edit(b, second, (t) => t.delete(3, 1));
    const link = edit(b, second, (t) => t.format(0, 2, "link", "u1"));
    for (const operations of [...bold, ...deleted, ...link])
      apply(a, operations);
    for (const operations of typed) apply(b, operations);
    // A reload learns the inherit rules of a text when it first reads it,
    // which makes what was computed before stale. Reading an origin in a
    // text not read yet did so in the middle of computing a run, which then
    // never counted as computed: it was computed forever.
    const x = { text: "x", attrs: { link: "u1" } };
    // What collided stays apart: b's "bc" is between a's letters on a.
    expect(read(a)).toStrictEqual([
      [
        { text: "a", attrs: {} },
        { text: "a", attrs: { link: "u1" } },
        { text: "c", attrs: { bold: true } },
        { text: "b", attrs: {} },
      ],
      [x],
    ]);
    expect(read(b)).toStrictEqual([
      [{ text: "ab", attrs: {} }],
      [
        x,
        { text: "b", attrs: { bold: true, link: "u1" } },
        { text: "c", attrs: { bold: true } },
      ],
    ]);
  });

  test("Base's text: letters it did not write yet make it take a new session", () => {
    const base = new Doc({ ...baseConfig(), id: ROOT_ID });
    base.forceCommit();
    const json = base.toJSON();
    const [a, b] = sameSession(() => [
      Doc.fromJSON({ ...baseConfig(), id: base.root.id }, json),
      Doc.fromJSON({ ...baseConfig(), id: base.root.id }, json),
    ]);
    const type = (doc: Doc, text: string) => {
      const sent: Operations[] = [];
      const off = doc.onChange((event) => sent.push(event.operations));
      rootText(doc).insert(rootText(doc).length, text);
      doc.forceCommit();
      off();
      return sent;
    };
    type(a, "ab");
    const fromB = type(b, "xyz");
    const session = nextSession(b);
    // In the server's order, a's letters went first: b's that collided
    // with them are skipped.
    for (const operations of fromB) apply(a, operations);
    expect(nextSession(a)).not.toBe(session);
    expect(rootText(a).get()).toBe("abz");
  });

  test("Base's text: with its own id generator, a document keeps its session", () => {
    const base = new Doc({ ...baseConfig(), id: ROOT_ID });
    base.forceCommit();
    const json = base.toJSON();
    const same = () => ({ ...baseConfig(), id: ROOT_ID, ...sameIdsOf() });
    const a = Doc.fromJSON(same(), json);
    const b = Doc.fromJSON(same(), json);
    const type = (doc: Doc, text: string) => {
      const sent: Operations[] = [];
      const off = doc.onChange((event) => sent.push(event.operations));
      rootText(doc).insert(rootText(doc).length, text);
      doc.forceCommit();
      off();
      return sent;
    };
    type(a, "ab");
    for (const operations of type(b, "xyz")) apply(a, operations);
    expect(nextSession(a)).toBe("same");
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
    const a = replica(Doc.fromJSON({ ...sameIds(), id: base.root.id }, json));
    const b = replica(Doc.fromJSON({ ...sameIds(), id: base.root.id }, json));
    a.write("from a");
    b.write("from b", "b again");
    for (const { operations } of b.sent) a.apply(operations);
    expect(nextSession(a.doc)).toBe("same");
  });
  test("text: with its own id generator, a document keeps its session", () => {
    const config = textConfig(false, "same");
    const base = new Doc({ ...config, id: ROOT_ID });
    const paragraph = base.createNode(Paragraph);
    base.root.append(paragraph);
    base.forceCommit();
    const json = base.toJSON();
    const a = Doc.fromJSON(
      { ...textConfig(false, "same"), id: base.root.id },
      json,
    );
    const b = Doc.fromJSON(
      { ...textConfig(false, "same"), id: base.root.id },
      json,
    );
    const typed = (doc: Doc, text: string) => {
      const sent: Operations[] = [];
      const off = doc.onChange((event) => sent.push(event.operations));
      const node = doc.getNodeById(paragraph.id);
      if (node?.is(Paragraph)) node.state.t.insert(0, text);
      doc.forceCommit();
      off();
      return sent;
    };
    typed(a, "ab");
    for (const operations of typed(b, "xyz")) apply(a, operations);
    expect(nextSession(a)).toBe("same");
  });
});
