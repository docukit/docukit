import { describe, expect, test } from "vitest";

import {
  defineNode,
  defineText,
  Doc,
  type JsonTree,
  type Operations,
} from "@docukit/docnode";
import {
  _INTERNAL_crdtTextStore,
  labelsEngine,
  labelsSnapshot,
} from "@docukit/docnode/crdt";

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

  test("letters with a first state next to a moved node travel with the labels", () => {
    const a = writer("a");
    const b = writer("b");
    const first = a.doc.createNode(Paragraph);
    const second = a.doc.createNode(Paragraph);
    a.doc.root.append(first, second);
    a.doc.forceCommit();
    b.receive(a.send());
    second.move(first, "before");
    first.state.t.insert(0, "x", { bold: true });
    a.doc.forceCommit();
    // The labels, then the insert of letters with their state, in its brackets.
    const [batch] = a.send();
    expect(Array.isArray(batch![2]) && Array.isArray(batch![2][0])).toBe(true);
    b.receive([batch!]);
    expect(b.texts()).toStrictEqual(["", "x"]);
    expect(b.paragraph(first.id).state.t.spans()).toStrictEqual(
      first.state.t.spans(),
    );
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

  test("a replica reloaded with the same session types after its old ids", () => {
    const a = writer("a");
    const b = writer("b");
    const line = b.doc.createNode(Paragraph);
    b.doc.root.append(line);
    line.state.t.insert(0, "xy");
    b.doc.forceCommit();
    a.receive(b.send());
    // A write of state counts from the next id of `a`: the letter "z".
    a.paragraph(line.id).state.t.format(0, 2, "bold", true);
    a.doc.forceCommit();
    a.paragraph(line.id).state.t.insert(2, "z");
    a.doc.forceCommit();
    b.receive(a.send());
    // Its generator names the same session again. New letters with the id
    // of the "z" would be read as it, and lost.
    a.reload();
    a.paragraph(line.id).state.t.insert(3, "!!");
    a.doc.forceCommit();
    line.state.t.insert(3, "?");
    b.doc.forceCommit();
    a.receive(b.send());
    b.receive(a.send());
    expect(a.texts()).toStrictEqual(["xyz!!?"]);
    expect(b.texts()).toStrictEqual(a.texts());
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

  test("a text typed in one go is stored as its letters alone", () => {
    const Root = defineNode({ type: "root", state: { t: defineText() } });
    const config = {
      type: "root",
      id: ROOT_ID,
      extensions: [{ nodes: [Root] }],
      crdt: labelsEngine(),
    };
    const letters = "a text longer than a short run";
    const doc = new Doc(config);
    if (doc.root.is(Root)) doc.root.state.t.insert(0, letters);
    doc.forceCommit();
    // Its one run needs nothing but its session, and the engine no labels.
    const json = doc.toJSON();
    expect(json.slice(1)).toStrictEqual(["root", 0, letters]);
    const copy = Doc.fromJSON(config, json);
    expect(copy.root.is(Root) && copy.root.state.t.get()).toBe(letters);
  });

  test("a text of edits still waiting for their letters is stored and loads", () => {
    const Root = defineNode({ type: "root", state: { t: defineText() } });
    const config = {
      type: "root",
      id: ROOT_ID,
      extensions: [{ nodes: [Root] }],
      crdt: labelsEngine(),
    };
    const a = new Doc(config);
    a.forceCommit();
    const sent: Operations[] = [];
    a.onChange((event) => sent.push(event.operations));
    const type = (at: number, letters: string) => {
      if (a.root.is(Root)) a.root.state.t.insert(at, letters);
      a.forceCommit();
    };
    type(0, "ab");
    type(2, "c");
    // The second edit arrives first: it waits for the letters it names.
    const b = new Doc(config);
    b.forceCommit();
    b.applyOperations(structuredClone(sent[1]!), { skipUndo: true });
    b.forceCommit();
    const copy = Doc.fromJSON(config, b.toJSON());
    copy.forceCommit();
    copy.applyOperations(structuredClone(sent[0]!), { skipUndo: true });
    copy.forceCommit();
    expect(copy.root.is(Root) && copy.root.state.t.get()).toBe("abc");
  });
});

describe("the text of the CRDT mode", () => {
  test("is FugueMax's, with tombstones; Base has its own", () => {
    const config = { type: "root", extensions: [{ nodes: [Paragraph] }] };
    const crdt = new Doc({ ...config, crdt: labelsEngine() });
    expect(_INTERNAL_crdtTextStore(crdt)["_debugRuns"]()).toStrictEqual([]);
    expect(() => _INTERNAL_crdtTextStore(new Doc(config))).toThrowError(
      "Not a CRDT document",
    );
  });
});
