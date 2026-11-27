import {
  Doc,
  type Operations,
  _INTERNAL_decodeOperations as decode,
  defineNode,
  text,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import {
  Paragraph,
  batchOf,
  batchesOf,
  bodies,
  config,
  docWithParagraph,
  first,
  paragraph,
  textDoc,
} from "./utils.js";

/** "👍" is one letter of two UTF-16 code units. */
const THUMB = "👍";

describe("text()", () => {
  test("a text never edited is empty", () => {
    const node = textDoc().createNode(Paragraph);
    expect([node.state.body.get(), node.state.body.length]).toStrictEqual([
      "",
      0,
    ]);
  });

  test("starts empty, and get, length, insert and delete edit it", () => {
    const { body } = docWithParagraph();
    expect([body.get(), body.length]).toStrictEqual(["", 0]);
    body.insert(0, "Hola mundo");
    body.delete(4, 6);
    body.insert(0, "¡");
    body.insert(5, "!");
    expect([body.get(), body.length]).toStrictEqual(["¡Hola!", 6]);
  });

  test("the methods can be called on their own", () => {
    const { node } = docWithParagraph();
    const { insert, get } = node.state.body;
    insert(0, "ab");
    expect(get()).toBe("ab");
  });

  test("set replaces the text with the smallest edit", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "Hola");
    doc.forceCommit();
    body.set((prev) => `${prev}!`);
    expect(body.changes()).toStrictEqual([
      { index: 4, deleted: 0, inserted: "!" },
    ]);
    doc.forceCommit();
    body.set("Hello!");
    expect(body.changes()).toStrictEqual([
      { index: 1, deleted: 0, inserted: "ello" },
      { index: 5, deleted: 3, inserted: "" },
    ]);
    expect(body.get()).toBe("Hello!");
  });

  test("set to the same text changes nothing", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abc");
    doc.forceCommit();
    body.set("abc");
    expect(body.changes()).toStrictEqual([]);
  });

  test("set with a caret picks where an edit in repeated letters goes", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "aaa");
    doc.forceCommit();
    // Typing "a" with the caret at 2: the new letter is the second one.
    body.set("aaaa", 2);
    expect(body.changes()).toStrictEqual([
      { index: 1, deleted: 0, inserted: "a" },
    ]);
    doc.forceCommit();
    // Deleting with the caret at 0: the first letter goes.
    body.set("aaa", 0);
    expect(body.changes()).toStrictEqual([
      { index: 0, deleted: 1, inserted: "" },
    ]);
    doc.forceCommit();
    // Without a caret, the edit goes after the common prefix.
    body.set("aaaa");
    expect(body.changes()).toStrictEqual([
      { index: 3, deleted: 0, inserted: "a" },
    ]);
  });

  test("set never splits a surrogate pair", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, `a${THUMB}`);
    doc.forceCommit();
    // "👍" and "👎" share their first code unit.
    body.set("a👎");
    expect(body.changes()).toStrictEqual([
      { index: 1, deleted: 0, inserted: "👎" },
      { index: 3, deleted: 2, inserted: "" },
    ]);
    doc.forceCommit();
    // "🁍" and "👍" share their last code unit.
    body.set("a🁍");
    doc.forceCommit();
    body.set(`a${THUMB}`);
    expect(body.changes()).toStrictEqual([
      { index: 1, deleted: 0, inserted: THUMB },
      { index: 3, deleted: 2, inserted: "" },
    ]);
    doc.forceCommit();
    body.set("a🔎");
    expect(body.get()).toBe("a🔎");
    doc.forceCommit();
    // A caret in the middle of a pair is not used.
    body.set(`a🔎${THUMB}🔎`);
    doc.forceCommit();
    body.set("a🔎🔎", 2);
    expect(body.get()).toBe("a🔎🔎");
    body.set(`${THUMB}${THUMB}`, 1);
    expect(body.get()).toBe(`${THUMB}${THUMB}`);
    doc.forceCommit();
    // Caret 3 would put the new pair at 1, in the middle of the first one.
    body.set(`${THUMB}${THUMB}${THUMB}`, 3);
    expect(body.changes()).toStrictEqual([
      { index: 4, deleted: 0, inserted: THUMB },
    ]);
  });

  test("a text of a node not inserted yet is inserted with the node", () => {
    const doc = textDoc();
    const node = doc.createNode(Paragraph);
    node.state.body.insert(0, "Hoa");
    node.state.body.insert(2, "l");
    node.state.body.delete(0, 1);
    expect(node.state.body.get()).toBe("ola");
    expect(node.state.body.changes()).toStrictEqual([]);
    const [, ...rows] = batchOf(doc, () => doc.root.append(node));
    // The node takes its id when inserted, and then its letters, in order.
    expect(rows).toStrictEqual([[0, -1, "p"], "@-1,body|ola"]);
  });

  test("set on a text of a node not inserted yet", () => {
    const doc = textDoc();
    const node = doc.createNode(Paragraph);
    const { body } = node.state;
    body.set("ab");
    body.set((prev) => `${prev}c`);
    body.set("abc");
    expect([body.get(), body.length]).toStrictEqual(["abc", 3]);
    expect(() => body.getPrev()).toThrowError("getPrev cannot be used");
    const [, ...rows] = batchOf(doc, () => doc.root.append(node));
    expect(rows).toStrictEqual([[0, -1, "p"], "@-1,body|abc"]);
  });

  test("a subtree takes the ids of its nodes first, and then of its letters", () => {
    const doc = textDoc();
    const [parent, child] = [
      doc.createNode(Paragraph),
      doc.createNode(Paragraph),
    ];
    child.state.body.insert(0, "cd");
    parent.state.body.insert(0, "ab");
    parent.append(child);
    const [head, ...rows] = batchOf(doc, () => doc.root.append(parent));
    // No letter row says where its letters start: they follow each other.
    expect(rows).toStrictEqual([
      [0, -2, "p"],
      "@-2,body|ab",
      [0, -1, "p", -2],
      "@-1,body|cd",
    ]);
    expect(head).toBe(`${parent.id.split(".")[0]}.1`);
  });

  test("a copy of a node copies its text, with new ids", () => {
    const doc = textDoc();
    const node = paragraph(doc, "ab");
    doc.forceCommit();
    const [, ...rows] = batchOf(doc, () => node.copy(node, "after"));
    expect(rows).toStrictEqual([[0, -1, "p", 0, -4], "@-1,body|ab"]);
    expect(bodies(doc)).toStrictEqual(["ab", "ab"]);
  });

  test("a stored document keeps a text as its string, and its letters keep their ids", () => {
    const doc = textDoc();
    paragraph(doc, "Hola");
    doc.forceCommit();
    const json = doc.toJSON();
    expect(json[7]).toStrictEqual(["Hola"]);
    const loaded = Doc.fromJSON(config, json);
    loaded.forceCommit();
    expect([bodies(loaded), first(loaded).state.body.length]).toStrictEqual([
      ["Hola"],
      4,
    ]);
    // An edit names the same letters in both: its prev and next.
    const edit = (doc: Doc) =>
      decode(batchOf(doc, () => first(doc).state.body.insert(4, "!")))[0][0];
    expect(edit(loaded)?.slice(2)).toStrictEqual(edit(doc)?.slice(2));
    expect(loaded.toJSON()[7]).toStrictEqual(["Hola!"]);
  });

  test("loading a document records its texts as the batch that made them", () => {
    const doc = textDoc();
    const [made] = batchesOf(doc, () => paragraph(doc, "Hola"));
    const loaded = Doc.fromJSON(
      { ...config, undoManager: { maxUndoSteps: 10 } },
      doc.toJSON(),
    );
    const batches: Operations[] = [];
    loaded.onChange(({ operations }) => batches.push(operations));
    loaded.forceCommit();
    expect(batches).toStrictEqual([made]);
  });

  test("the root can have a text", () => {
    const Root = defineNode({ type: "root", state: { title: text() } });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Root] }] });
    doc.forceCommit();
    const root = doc.root;
    if (!root.is(Root)) throw new Error("The root is not a Root");
    const [, ...rows] = batchOf(doc, () => root.state.title.insert(0, "T"));
    expect(rows).toStrictEqual(["@0,title|T"]);
  });
});

describe.each([
  ["in the document", () => docWithParagraph().body],
  // A string until the node is inserted, checked the same.
  ["of a node not inserted", () => textDoc().createNode(Paragraph).state.body],
])("text() errors, %s", (_, emptyBody) => {
  test.each([
    [-1, "The index -1 is out of the range of a text of length 2."],
    [3, "The index 3 is out of the range of a text of length 2."],
    [0.5, "The index 0.5 is out of the range of a text of length 2."],
  ])("insert at %d", (index, error) => {
    const body = emptyBody();
    body.insert(0, "ab");
    expect(() => body.insert(index, "x")).toThrowError(error);
  });

  test.each([
    [0, -1, "Cannot delete -1 letters."],
    [0, 0.5, "Cannot delete 0.5 letters."],
    [1, 2, "The end 3 is out of the range of a text of length 2."],
    [-1, 1, "The index -1 is out of the range of a text of length 2."],
  ])("delete at %d %d letters", (index, length, error) => {
    const body = emptyBody();
    body.insert(0, "ab");
    expect(() => body.delete(index, length)).toThrowError(error);
  });

  test("an edit cannot split a surrogate pair", () => {
    const body = emptyBody();
    body.insert(0, `a${THUMB}`);
    body.insert(3, THUMB);
    const error = "splits a surrogate pair";
    expect(() => body.insert(2, "x")).toThrowError(error);
    expect(() => body.delete(2, 1)).toThrowError(error);
    expect(() => body.delete(0, 2)).toThrowError(error);
    expect(() => body.delete(4, 1)).toThrowError(error);
    // A pair across two runs.
    expect(() => body.insert(4, "x")).toThrowError(error);
    body.delete(1, 4);
    expect(body.get()).toBe("a");
  });
});

describe("text() errors", () => {
  test("an empty insert or delete changes nothing", () => {
    const { doc, body } = docWithParagraph();
    expect(batchOf(doc, () => body.insert(0, "a")).length).toBe(2);
    let changes = 0;
    doc.onChange(() => changes++);
    body.insert(1, "");
    body.delete(0, 0);
    doc.forceCommit();
    expect(changes).toBe(0);
  });

  test.each([",", "|", ">"])("a text key cannot contain '%s'", (char) => {
    const Node = defineNode({ type: "n", state: { [`a${char}b`]: text() } });
    expect(
      () => new Doc({ type: "root", extensions: [{ nodes: [Node] }] }),
    ).toThrowError(
      `The text key 'a${char}b' of node type 'n' cannot contain ',', '|' or '>'.`,
    );
  });

  test("text() needs ids of the form session.clock", () => {
    let count = 0;
    const nodeIdGenerator = {
      generate: () => `id${count++}`,
      validate: () => true,
    };
    expect(() => textDoc({ nodeIdGenerator })).toThrowError(
      "The text key 'body' of node type 'p' needs ids of the form session.clock: a nodeIdGenerator without extractTime cannot be used with text().",
    );
  });

  test("a node whose id is not session.clock cannot have its text written", () => {
    const doc = textDoc();
    doc.applyOperations(["", [0, "custom", "p"]]);
    doc.forceCommit();
    expect(() => first(doc).state.body.insert(0, "a")).toThrowError(
      "The text of node 'custom' cannot be written: its id is not of the form session.clock.",
    );
  });

  test("a text cannot change in a change event", () => {
    const { doc, body } = docWithParagraph();
    doc.onChange(() => body.insert(0, "x"));
    body.insert(0, "a");
    expect(() => doc.forceCommit()).toThrowError(
      "You can't trigger an update inside a change stage",
    );
  });
});
