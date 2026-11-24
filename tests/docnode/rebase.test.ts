import { Doc, rebase, type DocNode, type Operations } from "@docukit/docnode";
import { labelsEngine } from "@docukit/docnode/crdt";
import { describe, expect, test } from "vitest";

import { randomizer, type Randomizer } from "./text/utils.js";
import { checkUndoManager, Text, TextExtension, text } from "./utils.js";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";
const SEEDS = Number(process.env.REBASE_FUZZ_SEEDS ?? 100);

const config = () => ({
  type: "root",
  id: ROOT_ID,
  extensions: [TextExtension],
  undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
});

/** A replica of what the server stores. */
function load(stored: Doc) {
  const doc = Doc.fromJSON(config(), stored.toJSON());
  doc.forceCommit();
  return doc;
}

/** The batches `edit` commits on `doc`. */
function batches(doc: Doc, edit: () => void): Operations[] {
  const out: Operations[] = [];
  const off = doc.onChange((event) => {
    if (!event.flags.skipUndo) out.push(event.operations);
  });
  edit();
  doc.forceCommit();
  off();
  return out;
}

function receive(doc: Doc, pending: Operations[]) {
  for (const batch of pending) doc.applyOperations(batch, { skipUndo: true });
  doc.forceCommit();
}

const values = (doc: Doc) => {
  const out: string[] = [];
  doc.root.descendants().forEach((node) => {
    if (node.is(Text)) out.push(node.state.value.get());
  });
  return out;
};

const kids = (doc: Doc) => {
  const out: DocNode[] = [];
  doc.root.children().forEach((node) => void out.push(node));
  return out;
};

/** A document with nodes `values`, committed. */
function server(...initial: string[]) {
  const doc = new Doc(config());
  doc.root.append(...text(doc, ...initial));
  doc.forceCommit();
  return doc;
}

/** One random change of the tree: insert, delete, move or set a value. */
function edit(doc: Doc, rng: Randomizer) {
  const nodes: DocNode[] = [];
  doc.root.descendants().forEach((node) => void nodes.push(node));
  const node = nodes.length > 0 ? rng.pick(nodes) : undefined;
  const roll = rng.next();
  if (!node || roll < 0.35) {
    const created = text(doc, `n${rng.int(100)}`);
    if (node) node.insertAfter(...created);
    else doc.root.append(...created);
  } else if (roll < 0.55) node.delete();
  else if (roll < 0.75) {
    const target = rng.pick(nodes);
    let inside = target === node;
    target.ancestors().forEach((up) => void (inside ||= up === node));
    if (!inside)
      node.move(target, rng.pick(["append", "before", "after"] as const));
  } else if (node.is(Text)) node.state.value.set(`v${rng.int(100)}`);
}

describe("rebase", () => {
  test("a document that never rebased cannot: nothing changes", () => {
    const doc = server("a");
    const other = load(doc);
    const remote = batches(other, () => other.root.append(...text(other, "b")));
    expect(rebase(doc, remote)).toBe(false);
    expect(values(doc)).toStrictEqual(["a"]);
    expect(rebase(doc)).toBe(true);
    expect(rebase(doc, remote)).toBe(true);
    expect(values(doc)).toStrictEqual(["a", "b"]);
  });

  test("a document with a CRDT engine keeps nothing to undo", () => {
    const doc = new Doc({ ...config(), crdt: labelsEngine() });
    doc.forceCommit();
    expect(rebase(doc)).toBe(false);
    doc.root.append(...text(doc, "a"));
    doc.forceCommit();
    expect(rebase(doc, [])).toBe(false);
    expect(values(doc)).toStrictEqual(["a"]);
  });

  test("the server's batches go before the pending ones, as loading it again does", () => {
    const stored = server("a", "b", "c");
    const mine = load(stored);
    const theirs = load(stored);
    rebase(mine);
    const pending = batches(mine, () => {
      const [a, b] = kids(mine);
      b!.move(mine.root, "prepend");
      a!.insertAfter(...text(mine, "x"));
      if (a?.is(Text)) a.state.value.set("A");
    });
    const remote = batches(theirs, () => {
      const [a, , c] = kids(theirs);
      c!.insertBefore(...text(theirs, "y"));
      a!.delete();
    });
    receive(stored, remote);
    receive(stored, pending);

    expect(rebase(mine, remote)).toBe(true);
    receive(mine, pending);
    expect(mine.toJSON()).toStrictEqual(stored.toJSON());
    // `a` was deleted first: `x` goes before what followed it, `b` (moved
    // before it) to the end, and its new value nowhere.
    expect(values(mine)).toStrictEqual(["y", "x", "c", "b"]);
  });

  test(`${SEEDS} random trees: in place, it is the document loading again makes`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = randomizer(seed);
      const stored = server("a", "b", "c", "d");
      const mine = load(stored);
      const theirs = load(stored);
      rebase(mine);
      let pending: Operations[] = [];
      for (let step = 0; step < 30; step++) {
        const roll = rng.next();
        if (roll < 0.4) pending.push(...batches(mine, () => edit(mine, rng)));
        else if (roll < 0.5)
          pending.push(...batches(mine, () => mine.undoManager.undo()));
        else if (roll < 0.8) {
          const remote = batches(theirs, () => edit(theirs, rng));
          receive(stored, remote);
          rebase(mine, remote);
          receive(mine, pending);
        } else {
          // The server orders the pending ones: they are its now.
          receive(stored, pending);
          receive(theirs, pending);
          rebase(mine, pending);
          pending = [];
        }
        const replacement = load(stored);
        receive(replacement, pending);
        expect(mine.toJSON(), `seed ${seed} step ${step}`).toStrictEqual(
          replacement.toJSON(),
        );
      }
    }
  });

  test("no undo takes its change events, and the history goes on", () => {
    const stored = server("a");
    const mine = load(stored);
    rebase(mine);
    const theirs = load(stored);
    const remote = batches(theirs, () =>
      theirs.root.append(...text(theirs, "b")),
    );
    const pending = batches(mine, () => mine.root.prepend(...text(mine, "x")));
    const flags: unknown[] = [];
    mine.onChange((event) => flags.push(event.flags));
    rebase(mine, remote);
    // Undoing what it did since the last rebase, then the server's batch.
    expect(flags).toStrictEqual([{ skipUndo: true }, { skipUndo: true }]);
    receive(mine, pending);
    expect(values(mine)).toStrictEqual(["x", "a", "b"]);
    // The undo history is the one it had: undo takes the pending insert.
    mine.undoManager.undo();
    mine.forceCommit();
    expect(values(mine)).toStrictEqual(["a", "b"]);
  });

  test("a batch that fails part of the way leaves the others as they are", () => {
    const stored = server("a", "b");
    const mine = load(stored);
    rebase(mine);
    // One moves `b` into `a`, another `a` into `b`: on the server, the second
    // move would put `a` inside itself, so it does nothing.
    const one = load(stored);
    const first = batches(one, () => {
      const [a, b] = kids(one);
      b!.move(a!, "append");
      one.root.append(...text(one, "c"));
    });
    const other = load(stored);
    const second = batches(other, () => {
      const [a, b] = kids(other);
      a!.move(b!, "append");
    });
    const pending = batches(mine, () => mine.root.append(...text(mine, "x")));
    receive(stored, [...first, ...second]);
    rebase(mine, [...first, ...second]);
    receive(mine, pending);
    receive(stored, pending);
    expect(mine.toJSON()).toStrictEqual(stored.toJSON());
    expect(values(mine)).toStrictEqual(["a", "b", "c", "x"]);
    expect(kids(mine)).toHaveLength(3);
  });

  test("edits after it undo and redo as usual", () => {
    const stored = server();
    const mine = load(stored);
    rebase(mine);
    const theirs = load(stored);
    const remote = batches(theirs, () => {
      theirs.root.append(...text(theirs, "c"));
      theirs.forceCommit();
      theirs.root.first!.delete();
    });
    rebase(mine, remote);
    checkUndoManager(2, mine, () => {
      mine.root.append(...text(mine, "a", "b"));
      mine.forceCommit();
      mine.root.first!.delete();
    });
  });
});
