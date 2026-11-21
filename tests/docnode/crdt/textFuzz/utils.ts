import { expect, test } from "vitest";

import {
  Doc,
  type DocNode,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import { labelsEngine } from "@docukit/docnode/crdt";

import { Paragraph, randomizer, type Randomizer } from "../../text/utils.js";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";
const SEEDS = Number(process.env.CRDT_FUZZ_SEEDS ?? 150);
const PEERS = ["a", "b", "c"];

/** How a history is played. */
type Setup = {
  /**
   * A replica may reload what it stored, with ids that go on (same session),
   * and its undo history, as DocSync does when it swaps the document.
   */
  reload: boolean;
  /** A replica may redo what it undid. */
  redo: boolean;
};

const SETUPS = {
  plain: { reload: false, redo: false },
  reload: { reload: true, redo: true },
} satisfies Record<string, Setup>;

/**
 * Paragraphs of letter-by-letter text, in a document with the CRDT engine:
 * the config of each peer, whose ids go on after a reload.
 */
function configs() {
  return PEERS.map((peer) => {
    let clock = 0;
    return () => ({
      type: "root",
      extensions: [{ nodes: [Paragraph] }],
      undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
      crdt: labelsEngine(),
      nodeIdGenerator: {
        generate: () => `${peer}.${clock++}`,
        validate: () => true,
      },
    });
  });
}

const paragraphs = (doc: Doc) => {
  const out: DocNode<typeof Paragraph>[] = [];
  doc.root.children().forEach((node) => {
    if (node.is(Paragraph)) out.push(node);
  });
  return out;
};

const view = (doc: Doc) =>
  paragraphs(doc).map((node) => [node.id, node.state.t.spans()]);

function edit(doc: Doc, rng: Randomizer, setup: Setup) {
  const nodes = paragraphs(doc);
  if (nodes.length === 0) {
    const fresh = doc.createNode(Paragraph);
    doc.root.append(fresh);
    fresh.state.t.insert(0, "new");
    return;
  }
  const node = rng.pick(nodes);
  const text = node.state.t.get();
  const roll = rng.next();
  if (roll < 0.35) {
    node.state.t.insert(rng.int(text.length + 1), rng.pick(["a", "bc", "x"]));
  } else if (roll < 0.5 && text.length > 0) {
    const start = rng.int(text.length);
    node.state.t.delete(start, Math.min(1 + rng.int(3), text.length - start));
  } else if (roll < 0.58 && text.length > 1) {
    node.state.t.format(0, 1 + rng.int(text.length - 1), "bold", true);
  } else if (roll < 0.65) {
    // Enter: a paragraph letter, in the same text.
    node.state.t.insert(rng.int(text.length + 1), "\x7f");
  } else if (roll < 0.72 && text.includes("\x7f")) {
    // Backspace at the start of a line: its paragraph letter goes.
    node.state.t.delete(text.indexOf("\x7f"), 1);
  } else if (roll < 0.8) {
    // A new paragraph node with the tail moved into it (delete + insert).
    const at = rng.int(text.length + 1);
    const fresh = doc.createNode(Paragraph);
    node.insertAfter(fresh);
    fresh.state.t.insert(0, text.slice(at));
    node.state.t.delete(at, text.length - at);
  } else if (roll < 0.9 && nodes.length > 1) {
    const target = rng.pick(nodes);
    if (target !== node)
      node.move(target, rng.next() < 0.5 ? "before" : "after");
  } else if (!setup.redo || roll < 0.95) {
    doc.undoManager.undo();
  } else {
    doc.undoManager.redo();
  }
}

function history(seed: number, setup: Setup) {
  const rng = randomizer(seed);
  const config = configs();
  const first = new Doc({ ...config[0]!(), id: ROOT_ID });
  first.forceCommit();
  for (const text of ["Hello world", "Second line", "Third"]) {
    const node = first.createNode(Paragraph);
    first.root.append(node);
    node.state.t.insert(0, text);
  }
  first.forceCommit();
  const load = (at: number, json: JsonDoc) => {
    const doc = Doc.fromJSON({ ...config[at]!(), id: ROOT_ID }, json);
    doc.forceCommit();
    return doc;
  };
  const json = first.toJSON();
  const docs = [first, load(1, json), load(2, json)];
  const log: { from: number; operations: Operations }[] = [];
  const delivered = docs.map(() => new Set<number>());
  const listen = (from: number) =>
    docs[from]!.onChange((event) => {
      if (event.flags.skipUndo) return;
      delivered[from]!.add(log.length);
      log.push({ from, operations: event.operations });
    });
  docs.forEach((_, from) => listen(from));
  const deliver = (index: number, to: number) => {
    docs[to]!.applyOperations(structuredClone(log[index]!.operations), {
      skipUndo: true,
    });
    docs[to]!.forceCommit();
    delivered[to]!.add(index);
  };
  const steps = 20 + rng.int(40);
  for (let step = 0; step < steps; step++) {
    const at = rng.int(docs.length);
    edit(docs[at]!, rng, setup);
    docs[at]!.forceCommit();
    if (log.length > 0 && rng.next() < 0.3) {
      const index = rng.int(log.length);
      const to = rng.int(docs.length);
      deliver(index, to);
      if (rng.next() < 0.3) deliver(index, to);
    }
    if (setup.reload && rng.next() < 0.05) {
      const undoHistory = docs[at]!.undoManager.exportHistory();
      docs[at] = load(at, docs[at]!.toJSON());
      docs[at].undoManager.importHistory(undoHistory);
      listen(at);
    }
  }
  for (let round = 0; round < 3; round++) {
    docs.forEach((_, to) => {
      const missing = log.map((_, index) => index);
      for (const index of rng.shuffle(missing))
        if (!delivered[to]!.has(index) || rng.next() < 0.2) deliver(index, to);
    });
  }
  return docs;
}

/** Seeds where an edit threw: a node whose text a link reads elsewhere. */
const REGRESSIONS = [2587, 1769];

/**
 * Random histories of letter-by-letter text played one way, and the seeds
 * that once failed. Each way is its own file, so they run in parallel.
 */
export function fuzzText(name: keyof typeof SETUPS) {
  const setup = SETUPS[name];
  if (name === "plain")
    test.each(REGRESSIONS)("seed %i converges", (seed) => {
      const docs = history(seed, setup);
      expect(new Set(docs.map((doc) => JSON.stringify(view(doc)))).size).toBe(
        1,
      );
    });

  test(
    `${SEEDS} random histories converge in any order, with repeats (${name})`,
    { timeout: Math.max(6000, SEEDS * 4) },
    () => {
      const diverged: number[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        let docs: Doc[];
        try {
          docs = history(seed, setup);
        } catch {
          // A local edit that throws: a broken state, reported as `-seed`.
          diverged.push(-seed);
          continue;
        }
        const views = docs.map((doc) => JSON.stringify(view(doc)));
        if (new Set(views).size > 1) diverged.push(seed);
      }
      expect(diverged).toStrictEqual([]);
    },
  );
}
