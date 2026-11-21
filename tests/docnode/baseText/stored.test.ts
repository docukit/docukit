import { Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import {
  config,
  flat,
  Network,
  Paragraph,
  reload,
  receive,
  rootText,
  ROOT_ID,
  runsOf,
  sent,
  stored,
} from "./utils.js";

/** A document with a paragraph node per text, and a root text. */
function nodes(texts: string[], root = "") {
  const { doc, text } = flat(root);
  const made = texts.map((value) => {
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, value);
    return node;
  });
  doc.forceCommit();
  return { doc, text, nodes: made };
}

/** Every text of `doc`. */
const everything = (doc: Doc) => {
  const out = [rootText(doc).get()];
  doc.root.children().forEach((node) => {
    if (node.is(Paragraph)) out.push(node.state.t.get());
  });
  return out;
};

describe("the stored text", () => {
  test("loads back the same, with its sessions and runs", () => {
    const network = new Network(`Hello world${"x".repeat(40)}`, ["a", "b"]);
    network.edit("a", (text) => {
      // Typed backwards: each letter before the one typed before it.
      for (let index = 0; index < 5; index++) text.insert(6, `${index}`);
    });
    network.edit("b", (text) => text.insert(3, "y".repeat(30)));
    network.exchange();
    const doc = network.doc("a");
    const copy = reload(doc);
    expect(everything(copy)).toStrictEqual(everything(doc));
    expect(stored(copy)).toBe(stored(doc));
    expect(runsOf(copy)).toStrictEqual(runsOf(doc));
  });

  test("of paragraph nodes, one after the other or not", () => {
    const { doc } = nodes(["one", "", "three"], "root");
    const other = doc.createNode(Paragraph);
    // A node whose id does not follow: of another generator.
    const late = Doc.fromJSON(
      { ...config("z"), id: doc.root.id },
      doc.toJSON(),
    );
    late.forceCommit();
    const node = late.createNode(Paragraph);
    late.root.append(node);
    node.state.t.insert(0, "late");
    late.forceCommit();
    doc.root.append(other);
    other.state.t.insert(0, "four");
    doc.forceCommit();
    for (const copy of [doc, late]) {
      const loaded = reload(copy);
      expect(everything(loaded)).toStrictEqual(everything(copy));
      expect(stored(loaded)).toBe(stored(copy));
    }
  });

  test("is the same however its runs were cut", () => {
    const { doc, text } = flat("abcdef");
    text.delete(1, 3);
    doc.forceCommit();
    // Back with their ids: one run again.
    doc.undoManager.undo();
    doc.forceCommit();
    expect(stored(doc)).toBe(stored(flat("abcdef").doc));
  });

  test("with letters with state, what a later version stores, does not load", () => {
    const json = flat("ab").doc.toJSON();
    json[6] = ["ab", [{ bold: true }]];
    expect(() => Doc.fromJSON({ ...config(), id: ROOT_ID }, json)).toThrowError(
      "The stored text has letters with state, which this version does not read.",
    );
  });

  test("an empty text is not stored", () => {
    const { doc } = nodes([""]);
    expect(doc.root.toJSON()[2]).toStrictEqual({});
    // Without text: `0` in its place, before the columns.
    expect(doc.toJSON()).toHaveLength(8);
    expect(doc.toJSON()[6]).toBe(0);
  });

  test("the document keeps its text before its columns, with the sessions of its tree", () => {
    const doc = new Doc({ ...config(), id: ROOT_ID });
    doc.forceCommit();
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, "Hello");
    doc.forceCommit();
    const [, , , sessions, , , text] = doc.toJSON();
    expect(sessions).toStrictEqual(["a"]);
    expect(text).toStrictEqual(["Hello"]);
    expect(reload(doc).root.first).toBeDefined();
  });

  test("keeps where deleted letters were, also in a text emptied since", () => {
    const network = new Network("abcdefgh", ["a", "b", "c"]);
    const early = reload(network.server);
    const { doc, nodes: made } = nodes(["one", "two", ""]);
    made[0]!.state.t.delete(0, 3);
    made[1]!.state.t.delete(1, 1);
    // An empty text with no ghost is not stored.
    made[2]!.state.t.delete(0, 1);
    doc.forceCommit();
    expect(stored(reload(doc))).toBe(stored(doc));
    network.edit("a", (text) => text.delete(1, 2));
    network.edit("b", (text) => {
      text.insert(8, "xyz");
      text.delete(5, 1);
    });
    network.exchange();
    network.edit("c", (text) => {
      text.delete(0, 1);
      text.delete(4, 3);
    });
    network.exchange();
    const server = network.server;
    const copy = reload(server);
    expect(stored(copy)).toBe(stored(server));
    // A late insert next to deleted letters goes where they were in both.
    const [late] = sent(early, () => rootText(early).insert(2, "L"));
    for (const target of [server, copy]) receive(target, late!);
    expect(rootText(server).get()).toBe("Ldegh");
    expect(rootText(copy).get()).toBe(rootText(server).get());
    expect(stored(copy)).toBe(stored(server));
  });

  test("many sessions, each a run, cost a few bytes each", () => {
    const network = new Network("", ["a", "b", "c", "d"]);
    for (const session of ["a", "b", "c", "d"])
      network.edit(session, (text) => text.insert(0, session.repeat(3)));
    network.exchange();
    const [, , , , , , text, columns] = network.server.toJSON();
    expect(text).toStrictEqual(["dddcccbbbaaa"]);
    expect(String(columns).length).toBeLessThan(30);
  });
});

describe("the store as JSON (what `toJSON` of its state writes)", () => {
  test("loads back, and is 0 when there is no text", () => {
    const { doc } = nodes(["one", "two"], "root");
    const json = doc.root.toJSON()[2];
    const copy = Doc.fromJSON({ ...config("c"), id: ROOT_ID }, [
      ROOT_ID,
      "root",
      json,
      [
        [doc.root.first!.id, "p", {}],
        [doc.root.last!.id, "p", {}],
      ],
    ]);
    copy.forceCommit();
    expect(everything(copy)).toStrictEqual(everything(doc));
    expect(flat().doc.root.toJSON()[2]).toStrictEqual({});
  });

  test("of another format, or not a store, does not load", () => {
    const tree = (value: unknown) =>
      Doc.fromJSON({ ...config(), id: ROOT_ID }, [
        ROOT_ID,
        "root",
        { "~t": JSON.stringify(value) },
      ]);
    expect(() => tree([11, [], ""])).toThrowError(
      "Unsupported text format: 11",
    );
    const doc = tree("text");
    doc.forceCommit();
    expect(rootText(doc).get()).toBe("");
  });
});
