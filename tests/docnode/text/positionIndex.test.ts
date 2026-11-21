import { type Doc, type Operations } from "@docukit/docnode";
import { _INTERNAL_crdtTextStore } from "@docukit/docnode/crdt";
import { describe, expect, test } from "vitest";

import {
  backspaceJoin,
  enter,
  paragraphs,
  randomizer,
  type ParagraphNode,
  type Randomizer,
} from "./utils.js";

/**
 * The store finds positions with a B-tree over the runs of each list. These
 * tests run the same random history on documents that use it and on documents
 * that use a plain walk, the reference, and compare every lookup.
 */

type Index = "tree" | "linear";
const INDEXES: Index[] = ["tree", "linear"];
const alphabet = ["a", "b", "xyz", "😀", " ", "hello world "];

/** Replaces the document's position index with a walk over the slice. */
function useLinearIndex(doc: Doc) {
  _INTERNAL_crdtTextStore(doc)["_positions"] = {
    length(root) {
      let length = 0;
      for (let run = root.next; run; run = run.next)
        if (run.visible) length += run.len;
      return length;
    },
    seek(root, index) {
      let before = 0;
      for (let run = root.next; run; run = run.next) {
        if (!run.visible) continue;
        if (index < before + run.len)
          return { run, off: index - before, before };
        before += run.len;
      }
      throw new Error(`No visible letter at ${index}`);
    },
    changed: () => undefined,
    linked: () => undefined,
    removed: () => undefined,
    before(_root, target) {
      let before = 0;
      for (let run = target.flow.head; run !== target; run = run.next!)
        if (run.visible) before += run.len;
      return before;
    },
  };
}

/** A document with one paragraph of `text`, using the given index. */
function documentWith(index: Index, text: string, session: string) {
  const { doc, nodes } = paragraphs([text], true, session);
  if (index === "linear") useLinearIndex(doc);
  return { doc, text: nodes[0]!.state.t };
}

type Replica = { doc: Doc; outbox: Operations[] };

function replicasFor(index: Index): Replica[] {
  return ["a", "b"].map((session) => {
    const { doc } = documentWith(index, "the quick brown fox", session);
    const replica: Replica = { doc, outbox: [] };
    doc.onChange(({ operations, flags }) => {
      if (!flags.skipUndo) replica.outbox.push(operations);
    });
    return replica;
  });
}

const paragraphsOf = (doc: Doc) => {
  const nodes: ParagraphNode[] = [];
  doc.root.children().forEach((node) => nodes.push(node as ParagraphNode));
  return nodes;
};

/** One random step, decided only by `rng`, so every index gets the same one. */
function step(replicas: Replica[], rng: Randomizer, last: { index: number }) {
  const replica = replicas[rng.int(2)]!;
  const doc = replica.doc;
  const roll = rng.next();
  if (roll < 0.1) {
    // Deliver what the other replica has sent so far.
    const other = replicas.find((r) => r !== replica)!;
    for (const operations of other.outbox.splice(0)) {
      doc.applyOperations(operations, { skipUndo: true });
      doc.forceCommit();
    }
    return;
  }
  if (roll < 0.13) {
    doc.undoManager.undo();
    doc.forceCommit();
    return;
  }
  const nodes = paragraphsOf(doc);
  const node = nodes[rng.int(nodes.length)]!;
  const length = node.state.t.get().length;
  // Mostly typing near the last position, sometimes a jump.
  const index =
    rng.next() < 0.7
      ? Math.max(0, last.index + rng.int(5) - 2)
      : rng.int(length + 2);
  last.index = index;
  if (roll < 0.6) node.state.t.insert(index, rng.pick(alphabet));
  else if (roll < 0.85) node.state.t.delete(index, 1 + rng.int(8));
  else if (roll < 0.9) node.state.t.format(index, index + 3, "bold", true);
  else if (roll < 0.95 && nodes.length < 8) enter(doc, node, index);
  else if (node !== nodes[0])
    backspaceJoin(nodes[nodes.indexOf(node) - 1]!, node);
  doc.forceCommit();
}

/**
 * Texts, plus the id and offset each lookup finds at some random indexes,
 * and where every letter seen so far is now (deleted, moved or not).
 */
function snapshot(replicas: Replica[], probe: Randomizer, seen: string[]) {
  return replicas.map(({ doc }) => {
    const store = _INTERNAL_crdtTextStore(doc);
    return paragraphsOf(doc).map((node) => {
      const text = node.state.t.get();
      const found = [0, 1, 2, 3].map(() => {
        const index = probe.int(text.length + 2);
        const result = store["_seek"](node.id, index);
        const letter = node.state.t.letterAt(index);
        if (letter !== undefined && !seen.includes(letter)) {
          seen.push(letter);
          if (seen.length > 24) seen.shift();
        }
        return typeof result === "number"
          ? result
          : [result.run.s, result.run.c + result.off, result.before];
      });
      const letters = seen.map((letter) => node.state.t.indexOfLetter(letter));
      return { text, found, letters };
    });
  });
}

describe("the position index agrees with a plain walk", () => {
  test.each([1, 2, 3, 4])("seed %i", (seed) => {
    const runs = INDEXES.map((index) => ({
      replicas: replicasFor(index),
      rng: randomizer(seed),
      probe: randomizer(seed * 7919),
      last: { index: 0 },
      seen: new Array<string>(),
    }));
    for (let i = 0; i < 400; i++) {
      for (const run of runs) step(run.replicas, run.rng, run.last);
      const [tree, linear] = runs.map((run) =>
        snapshot(run.replicas, run.probe, run.seen),
      );
      expect(tree).toStrictEqual(linear);
    }
  });

  test("a long single-session history in a 20,000-letter text", () => {
    const texts = INDEXES.map(
      (index) => documentWith(index, "x".repeat(20_000), "s").text,
    );
    const rng = randomizer(42);
    let plain = "x".repeat(20_000);
    // Letters all over the text: many get deleted, all move.
    const letters = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (eighth) => texts[0]!.letterAt(eighth * 2500)!,
    );
    for (let i = 0; i < 1500; i++) {
      const index = rng.int(plain.length);
      if (rng.next() < 0.5) {
        for (const t of texts) t.insert(index, "ab");
        plain = plain.slice(0, index) + "ab" + plain.slice(index);
      } else {
        for (const t of texts) t.delete(index, 3);
        plain = plain.slice(0, index) + plain.slice(index + 3);
      }
    }
    for (const t of texts) expect(t.get()).toBe(plain);
    const [tree, linear] = texts.map((t) =>
      letters.map((letter) => t.indexOfLetter(letter)),
    );
    expect(tree).toStrictEqual(linear);
  });
});
