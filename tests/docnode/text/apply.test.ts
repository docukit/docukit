import {
  Doc,
  type DocNode,
  _INTERNAL_decodeOperations as decode,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import {
  Paragraph,
  bodies,
  config,
  docWithParagraph,
  first,
  orderedServer,
  paragraph,
  textDoc,
} from "./utils.js";

type Edit = (
  body: DocNode<typeof Paragraph>["state"]["body"],
  doc: Doc,
) => void;

/**
 * Two replicas edit the first paragraph at once from what `setup` made. The
 * server gets `a` first, then `b`. Replica A applies `b` over its state, and
 * replica B rebases its pending `b` over the server's state. Returns the
 * texts of the server and both replicas.
 */
function concurrent(setup: (doc: Doc) => void, a: Edit, b: Edit) {
  const { server, replica, edit, send, rebase } = orderedServer(setup);
  const [docA, docB] = [replica(), replica()];
  const batchesA = edit(docA, (doc) => a(first(doc).state.body, doc));
  const batchesB = edit(docB, (doc) => b(first(doc).state.body, doc));
  send(batchesA);
  send(batchesB);
  for (const batch of batchesB) docA.applyOperations(batch);
  docA.forceCommit();
  const rebased = rebase(batchesB);
  return [server, docA, rebased].map(bodies);
}

describe("applying letter rows", () => {
  test("a remote insert lands where it was made", () => {
    const { replica, edit } = orderedServer((doc) =>
      paragraph(doc, "Hola mundo"),
    );
    const [docA, docB] = [replica(), replica()];
    const batches = edit(docA, () => {
      first(docA).state.body.insert(4, ",");
      first(docA).state.body.insert(5, "!");
      first(docA).state.body.insert(0, "¡");
    });
    for (const batch of batches) docB.applyOperations(batch);
    expect(bodies(docB)).toStrictEqual(["¡Hola,! mundo"]);
    expect(docB.toJSON()).toStrictEqual(docA.toJSON());
  });

  test("concurrent inserts at the same place: the later one goes first", () => {
    const result = concurrent(
      (doc) => paragraph(doc, "ab"),
      (body) => body.insert(1, "X"),
      (body) => body.insert(1, "Y"),
    );
    expect(result).toStrictEqual([["aYXb"], ["aYXb"], ["aYXb"]]);
  });

  test("if prev is gone, the letters go before next", () => {
    const setup = (doc: Doc) => {
      const node = paragraph(doc, "ac");
      node.state.body.insert(1, "b");
    };
    // "b" and "c" were not made one after the other: next is written.
    expect(
      concurrent(
        setup,
        (body) => body.delete(1, 1),
        (body) => body.insert(2, "X"),
      ),
    ).toStrictEqual([["aXc"], ["aXc"], ["aXc"]]);
    // In a run, next is the letter made after prev.
    expect(
      concurrent(
        (doc) => paragraph(doc, "abc"),
        (body) => body.delete(1, 1),
        (body) => body.insert(2, "X"),
      ),
    ).toStrictEqual([["aXc"], ["aXc"], ["aXc"]]);
  });

  test("if prev and next are gone, the letters are dropped", () => {
    expect(
      concurrent(
        (doc) => paragraph(doc, "abc"),
        (body) => body.delete(1, 2),
        (body) => body.insert(2, "X"),
      ),
    ).toStrictEqual([["a"], ["a"], ["a"]]);
    // At the end of the text, there is no next.
    expect(
      concurrent(
        (doc) => paragraph(doc, "abc"),
        (body) => body.delete(2, 1),
        (body) => body.insert(3, "X"),
      ),
    ).toStrictEqual([["ab"], ["ab"], ["ab"]]);
  });

  test("an insert into an empty text goes first if the text has letters", () => {
    expect(
      concurrent(
        (doc) => paragraph(doc),
        (body) => body.insert(0, "x"),
        (body) => body.insert(0, "y"),
      ),
    ).toStrictEqual([["yx"], ["yx"], ["yx"]]);
  });

  test("an insert into the text of a deleted node is dropped", () => {
    expect(
      concurrent(
        (doc) => paragraph(doc),
        (_, doc) => doc.root.first!.delete(),
        (body) => body.insert(0, "y"),
      ),
    ).toStrictEqual([[], [], []]);
  });

  test("a delete whose first or last letter is gone is dropped", () => {
    expect(
      concurrent(
        (doc) => paragraph(doc, "abcd"),
        (body) => body.delete(2, 1),
        (body) => body.delete(1, 2),
      ),
    ).toStrictEqual([["abd"], ["abd"], ["abd"]]);
  });

  test("an insert inside a range deleted concurrently is lost (accepted)", () => {
    expect(
      concurrent(
        (doc) => paragraph(doc, "abcd"),
        (body) => body.insert(2, "X"),
        (body) => body.delete(0, 4),
      ),
    ).toStrictEqual([[""], [""], [""]]);
  });

  test("a rebase of pending edits over the server's converges", () => {
    expect(
      concurrent(
        (doc) => paragraph(doc, "Hola"),
        (body) => {
          body.insert(4, " mundo");
          body.delete(0, 1);
        },
        (body) => {
          body.set("Hola!");
          body.insert(0, "¡");
        },
      ),
      // "¡" went before "H", which A deleted: it has no anchor left.
    ).toStrictEqual([["ola! mundo"], ["ola! mundo"], ["ola! mundo"]]);
  });

  test("letters that are here already are left as they are", () => {
    const { replica, edit } = orderedServer((doc) => paragraph(doc, "ab"));
    const [docA, docB] = [replica(), replica()];
    const batches = edit(docA, () => first(docA).state.body.insert(1, "X"));
    let changes = 0;
    docB.onChange(() => changes++);
    for (let i = 0; i < 2; i++) {
      docB.applyOperations(batches[0]!);
      docB.forceCommit();
    }
    expect([bodies(docB), changes]).toStrictEqual([["aXb"], 1]);
  });

  test("a delete across texts, or backwards, is dropped", () => {
    const { log, replica } = orderedServer((doc) => {
      paragraph(doc, "ab");
      paragraph(doc, "cd");
    });
    const [ab, cd] = decode(log[0]!)[0].filter((op) => op[0] === 4);
    const a = ab![1];
    const c = cd![1];
    const b = `${a.slice(0, -1)}${String.fromCharCode(a.charCodeAt(a.length - 1) + 1)}`;
    const doc = replica();
    doc.applyOperations(["", 1, a, c]);
    doc.applyOperations(["", 1, b, a]);
    expect(bodies(doc)).toStrictEqual(["ab", "cd"]);
    doc.applyOperations(["", 1, a, b]);
    expect(bodies(doc)).toStrictEqual(["", "cd"]);
  });

  test("an insert into a key that is not a text, or of a missing node, is dropped", () => {
    const { replica } = orderedServer((doc) => paragraph(doc, "ab"));
    const doc = replica();
    const node = doc.root.first!.id;
    doc.applyOperations(["a.1", `@${node},title|x`]);
    doc.applyOperations(["a.1", "@0,body|x"]);
    doc.applyOperations(["a.1", "@b.1,body|x"]);
    doc.applyOperations(["a.1", "c.1,c.2|x"]);
    doc.applyOperations(["", 1, "custom"]);
    expect(bodies(doc)).toStrictEqual(["ab"]);
    expect(first(doc).state.title.get()).toBe("");
  });

  test("a state patch does not set a text", () => {
    const { replica } = orderedServer((doc) => paragraph(doc, "ab"));
    const doc = replica();
    const node = doc.root.first!.id;
    doc.applyOperations([node, [3, node, "body", "x", node, "title", "t"]]);
    expect(bodies(doc)).toStrictEqual(["ab"]);
    expect(first(doc).state.title.get()).toBe("t");
  });

  test("a document without texts drops letter rows", () => {
    const doc = new Doc({ type: "root", extensions: [] });
    doc.applyOperations(["a.1", "@0,body|x"]);
    doc.applyOperations(["a.1", 1, 1]);
    expect(doc.root.first).toBeUndefined();
  });

  test("a letter of this session that it did not make starts a new session", () => {
    const { doc, node } = docWithParagraph();
    const session = node.id.split(".")[0]!;
    doc.applyOperations([`${session}.z`, `@${node.id},body|q`]);
    expect(node.state.body.get()).toBe("q");
    expect(doc.createNode(Paragraph).id.split(".")[0]).not.toBe(session);
  });

  test("the letters of a deleted node leave the document, and an undo brings them back", () => {
    const { log, replica, edit } = orderedServer((doc) => paragraph(doc, "ab"));
    const docA = replica();
    const docB = textDoc({
      id: docA.root.id,
      undoManager: { maxUndoSteps: 10, mergeInterval: 0 },
    });
    for (const batch of log) docB.applyOperations(batch);
    docB.forceCommit();
    const [insertX] = edit(docA, () => first(docA).state.body.insert(1, "X"));
    const [insertY] = edit(docA, () => first(docA).state.body.insert(0, "Y"));
    // A row that names a letter: B finds letters by id from now on.
    docB.applyOperations(insertY!);
    docB.forceCommit();
    docB.root.first!.delete();
    docB.forceCommit();
    docB.applyOperations(insertX!);
    expect(bodies(docB)).toStrictEqual([]);
    docB.undoManager.undo();
    expect(bodies(docB)).toStrictEqual(["Yab"]);
    docB.applyOperations(insertX!);
    expect(bodies(docB)).toStrictEqual(["YaXb"]);
  });

  test("a loaded text has new ids, which batches of others do not name", () => {
    const { server, replica, edit } = orderedServer((doc) =>
      paragraph(doc, "ab"),
    );
    const loaded = Doc.fromJSON(config, server.toJSON());
    const doc = replica();
    const [batch] = edit(doc, () => first(doc).state.body.insert(1, "X"));
    loaded.applyOperations(batch!);
    expect(bodies(loaded)).toStrictEqual(["ab"]);
    // Its letters get ids when it is first edited, or copied.
    first(loaded).state.body.insert(2, "!");
    first(loaded).copy(loaded.root, "append");
    expect(bodies(loaded)).toStrictEqual(["ab!", "ab!"]);
  });
});
