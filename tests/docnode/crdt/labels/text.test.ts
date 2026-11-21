import { describe, expect, test } from "vitest";

import { Doc, type JsonTree, type Operations } from "@docukit/docnode";
import { labelsEngine, labelsSnapshot } from "@docukit/docnode/crdt";

import { Paragraph } from "../../text/utils.js";
import { Text } from "../../utils.js";
import {
  createReplica,
  deliver,
  expectSameTree,
  insert,
  ROOT_ID,
  take,
  tree,
} from "./utils.js";

/** A replica whose nodes are paragraphs of letter-by-letter text. */
function writer(peer: string) {
  let clock = 0;
  const config = () => ({
    type: "root",
    extensions: [{ nodes: [Paragraph] }],
    undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
    crdt: labelsEngine(),
    nodeIdGenerator: {
      generate: () => `${peer}.${clock++}`,
      validate: () => true,
    },
  });
  const outbox: Operations[] = [];
  const listen = (doc: Doc) => {
    doc.forceCommit();
    doc.onChange((event) => {
      if (!event.flags.skipUndo) outbox.push(event.operations);
    });
    return doc;
  };
  const replica = {
    doc: listen(new Doc({ ...config(), id: ROOT_ID })),
    send: () => outbox.splice(0),
    receive: (batches: Operations[]) => {
      for (const batch of batches) {
        replica.doc.applyOperations(structuredClone(batch), { skipUndo: true });
      }
    },
    texts: () => {
      const out: string[] = [];
      replica.doc.root.children().forEach((node) => {
        if (node.is(Paragraph)) out.push(node.state.t.get());
      });
      return out;
    },
    /** Its paragraph `id`, which it must have. */
    paragraph: (id: string) => {
      const node = replica.doc.getNodeById(id);
      if (!node?.is(Paragraph)) throw new Error(`No paragraph ${id}`);
      return node;
    },
    /** Opens what it stored, with the same ids: the same session goes on. */
    reload: () => {
      replica.doc = listen(
        Doc.fromJSON(
          { ...config(), id: replica.doc.root.id },
          replica.doc.toJSON(),
        ),
      );
    },
    /** `reload`, keeping its undo history (as DocSync does on a swap). */
    reloadWithHistory: () => {
      const history = replica.doc.undoManager.exportHistory();
      replica.reload();
      replica.doc.undoManager.importHistory(history);
    },
  };
  return replica;
}

describe("letter-by-letter text", () => {
  test("text edits travel with the labels and merge letter by letter", () => {
    const a = writer("a");
    const b = writer("b");
    const paragraph = a.doc.createNode(Paragraph);
    a.doc.root.append(paragraph);
    paragraph.state.t.insert(0, "Hello");
    a.doc.forceCommit();
    b.receive(a.send());
    // Typing in a paragraph that exists changes no label.
    paragraph.state.t.insert(5, "!");
    a.doc.forceCommit();
    const other = b.doc.getNodeById(paragraph.id);
    if (other?.is(Paragraph)) other.state.t.insert(0, ">");
    b.doc.forceCommit();
    const fromA = a.send();
    const fromB = b.send();
    expect(JSON.stringify(fromA)).not.toContain("[3,");
    a.receive(fromB);
    b.receive(fromA);
    expect(a.texts()).toStrictEqual([">Hello!"]);
    expect(b.texts()).toStrictEqual(a.texts());
  });

  test("a node inserted and deleted while typing leaves only the typing", () => {
    const a = writer("a");
    const b = writer("b");
    const paragraph = a.doc.createNode(Paragraph);
    a.doc.root.append(paragraph);
    a.doc.forceCommit();
    b.receive(a.send());
    paragraph.state.t.insert(0, "hi");
    const passing = a.doc.createNode(Paragraph);
    a.doc.root.append(passing);
    passing.delete();
    a.doc.forceCommit();
    const sent = a.send();
    expect(JSON.stringify(sent)).not.toContain(passing.id);
    b.receive(sent);
    expect(b.texts()).toStrictEqual(["hi"]);
  });

  test("a delete next to a new node travels with the labels", () => {
    const a = writer("a");
    const b = writer("b");
    const first = a.doc.createNode(Paragraph);
    a.doc.root.append(first);
    first.state.t.insert(0, "abc");
    a.doc.forceCommit();
    b.receive(a.send());
    a.doc.root.append(a.doc.createNode(Paragraph));
    a.paragraph(first.id).state.t.delete(0, 1);
    a.doc.forceCommit();
    b.receive(a.send());
    expect(b.texts()).toStrictEqual(["bc", ""]);
  });

  test("an undo of typing goes back as a text edit", () => {
    const a = writer("a");
    const b = writer("b");
    const paragraph = a.doc.createNode(Paragraph);
    a.doc.root.append(paragraph);
    a.doc.forceCommit();
    paragraph.state.t.insert(0, "abc");
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    b.receive(a.send());
    expect(a.texts()).toStrictEqual([""]);
    expect(b.texts()).toStrictEqual([""]);
  });

  test("a replica reloaded with its undo history redoes what it undid", () => {
    const a = writer("a");
    const b = writer("b");
    const line = a.doc.createNode(Paragraph);
    a.doc.root.append(line);
    line.state.t.insert(0, "ab");
    a.doc.forceCommit();
    const format = (key: string) => {
      a.paragraph(line.id).state.t.format(0, 2, key, true);
      a.doc.forceCommit();
    };
    format("bold");
    format("italic");
    // The redo of "italic" holds an id the document never applied: a mark
    // made again gets its own one.
    a.doc.undoManager.undo();
    a.reloadWithHistory();
    // The redo of "bold" must not take that id too.
    a.doc.undoManager.undo();
    a.doc.undoManager.redo();
    a.doc.undoManager.redo();
    b.receive(a.send());
    expect(a.paragraph(line.id).state.t.spans()).toStrictEqual([
      { text: "ab", attrs: { bold: true, italic: true } },
    ]);
    expect(b.paragraph(line.id).state.t.spans()).toStrictEqual(
      a.paragraph(line.id).state.t.spans(),
    );
  });
});

describe("batches", () => {
  test("a batch with no rows changes nothing", () => {
    const a = createReplica({ peer: "a" });
    insert(a, a.doc.root, "x");
    a.doc.applyOperations([""]);
    expect(tree(a)).toBe("root(x)");
  });

  test("a batch received during a transaction commits it first", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    insert(a, a.doc.root, "x");
    const node = b.doc.createNode(Text);
    b.doc.root.append(node);
    deliver(b, take(a));
    deliver(a, take(b));
    expectSameTree(a, b);
    expect(tree(a)).toContain("x");
  });

  test("a broken labels row changes nothing", () => {
    const a = createReplica({ peer: "a" });
    insert(a, a.doc.root, "x");
    deliver(a, [["", [3, 1, [[0, [5, 6, 7]]], [[8, 0, true]]]]]);
    expect(tree(a)).toBe("root(x)");
  });

  test("sessions with a dot travel too", () => {
    const a = createReplica({ peer: "x.y" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    deliver(b, take(a));
    x.delete();
    a.doc.forceCommit();
    deliver(b, take(a));
    expectSameTree(a, b);
    expect(tree(b)).toBe("root");
  });

  test("ids that start with ! travel as they are", () => {
    const a = createReplica({ peer: "!a", plainIds: true });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    deliver(b, take(a));
    expect(b.doc.getNodeById(x.id)).toBeDefined();
    expectSameTree(a, b);
  });
});

describe("stored documents", () => {
  test("a snapshot of a document without labels merges nothing", () => {
    const a = createReplica({ peer: "a" });
    insert(a, a.doc.root, "x");
    const plain = new Doc({ id: ROOT_ID, type: "root", extensions: [] });
    deliver(a, [labelsSnapshot(plain.toJSON())]);
    expect(tree(a)).toBe("root(x)");
  });

  test("a document as nested nodes loads with labels every replica agrees on", () => {
    const config = {
      type: "root",
      extensions: [{ nodes: [Text] }],
      crdt: labelsEngine(),
    };
    const json: JsonTree = [
      ROOT_ID,
      "root",
      {},
      [["01jz0000000000000000000001", "text", { value: '"x"' }]],
    ];
    const a = Doc.fromJSON(config, json);
    const b = Doc.fromJSON(config, json);
    a.forceCommit();
    b.forceCommit();
    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
    // Those labels are stored as derived from the order, and read back so.
    const reloaded = Doc.fromJSON({ ...config, id: a.root.id }, a.toJSON());
    reloaded.forceCommit();
    expect(reloaded.toJSON()).toStrictEqual(a.toJSON());
  });
});
