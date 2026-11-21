import { describe, expect, test } from "vitest";

import {
  backspaceJoin,
  deliverUnreported,
  enter,
  orderedCluster,
  paragraphs,
  randomizer,
  type Cluster,
  type Entry,
  type Randomizer,
} from "./utils.js";

/**
 * Every local edit checked against a plain string, while remote operations,
 * undo, Enter and Backspace keep reshaping the lists the store indexes.
 */

const alphabet = ["a", "b", "xyz", "😀", " ", "hello "];

/** Where an edit at `index` lands: clamped, and never inside a surrogate pair. */
function snap(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  const pair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00;
  return pair && low <= 0xdfff ? index + 1 : index;
}

const insertInto = (text: string, index: number, insert: string) => {
  const at = snap(text, index);
  return text.slice(0, at) + insert + text.slice(at);
};

const deleteFrom = (text: string, index: number, length: number) => {
  const from = snap(text, index);
  const to = snap(text, Math.min(text.length, index + length));
  return to <= from ? text : text.slice(0, from) + text.slice(to);
};

/** A random index that is sometimes past the end or inside a surrogate pair. */
const anyIndex = (rng: Randomizer, text: string) =>
  rng.int(text.length + 3) - 1;

/** One local edit on `replica`; returns what its paragraphs must read after it. */
function localEdit(cluster: Cluster, replica: number, rng: Randomizer) {
  const ids = cluster.paragraphIds(replica);
  const id = rng.pick(ids);
  const node = cluster.node(replica, id);
  const text = node.state.t.get();
  const expected = new Map(ids.map((i) => [i, cluster.text(replica, i)]));
  const roll = rng.next();
  cluster.edit(replica, (doc) => {
    if (roll < 0.45) {
      const index = anyIndex(rng, text);
      const insert = rng.pick(alphabet);
      node.state.t.insert(index, insert);
      expected.set(id, insertInto(text, index, insert));
    } else if (roll < 0.75) {
      const index = anyIndex(rng, text);
      const length = 1 + rng.int(6);
      node.state.t.delete(index, length);
      expected.set(id, deleteFrom(text, index, length));
    } else if (roll < 0.85) {
      const from = anyIndex(rng, text);
      node.state.t.format(from, from + 1 + rng.int(4), "bold", true);
    } else if (replica !== 0) {
      // Tree edits need the server's order: only replica 0 makes them.
      return;
    } else if (roll < 0.93 && ids.length < 6) {
      const at = snap(text, anyIndex(rng, text));
      const fresh = enter(doc, node, at);
      expected.set(id, text.slice(0, at));
      expected.set(fresh.id, text.slice(at));
    } else if (ids.length > 1 && id !== ids[0]) {
      const target = cluster.node(replica, ids[ids.indexOf(id) - 1]!);
      expected.set(target.id, target.state.t.get() + text);
      expected.delete(id);
      backspaceJoin(target, node);
    }
  });
  return expected;
}

/** Delivers `entry` and checks that every paragraph whose text changed is reported. */
function deliverChecked(cluster: Cluster, entry: Entry, to: number) {
  expect(deliverUnreported(cluster, entry, to)).toStrictEqual([]);
}

function runHistory(seed: number, steps: number) {
  const rng = randomizer(seed);
  const cluster = orderedCluster(["the quick brown fox 😀 jumps"], 3, true);
  const delivered = cluster.docs.map(() => new Set<number>());
  for (let step = 0; step < steps; step++) {
    const replica = rng.int(3);
    const roll = rng.next();
    if (roll < 0.65) {
      const expected = localEdit(cluster, replica, rng);
      expect(
        new Map(
          cluster
            .paragraphIds(replica)
            .map((id) => [id, cluster.text(replica, id)]),
        ),
      ).toStrictEqual(expected);
      for (const entry of cluster.log.slice(-1))
        delivered[replica]!.add(entry.id);
    } else if (roll < 0.72) {
      // No undo: undoing a delete and a peer's concurrent delete of the same
      // letters only agree in the server's order, and these replicas get each
      // other's edits in any order (undo has its own tests).
      continue;
    } else {
      // In order per author; authors interleave at random.
      const pending = cluster.log.filter(
        (entry) => entry.from !== replica && !delivered[replica]!.has(entry.id),
      );
      const firsts = [...new Set(pending.map((entry) => entry.from))].map(
        (from) => pending.find((entry) => entry.from === from)!,
      );
      if (firsts.length === 0) continue;
      const entry = rng.pick(firsts);
      delivered[replica]!.add(entry.id);
      deliverChecked(cluster, entry, replica);
    }
  }
  cluster.deliverAll();
  cluster.assertConverged();
}

describe("positions against a plain string", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    "seed %i: local edits land where a plain string says",
    (seed) => runHistory(seed, 250),
  );

  test("a long history keeps finding runs after many splits", () => {
    // Deleting single letters inside long runs splits them: well over one
    // chunk of the per-session run index.
    const { doc, nodes } = paragraphs(["x".repeat(4000)]);
    const t = nodes[0]!.state.t;
    let plain = "x".repeat(4000);
    for (let i = 3998; i > 0; i -= 3) {
      t.delete(i, 1);
      plain = deleteFrom(plain, i, 1);
      if (i % 300 === 1) t.insert(i, "y");
      if (i % 300 === 1) plain = insertInto(plain, i, "y");
    }
    doc.forceCommit();
    expect(t.get()).toBe(plain);
    t.insert(2000, "!");
    expect(t.get()).toBe(insertInto(plain, 2000, "!"));
  });

  test("an edit after a remote change finds its place again", () => {
    const cluster = orderedCluster(["abcdef"], 2);
    const [id] = cluster.ids;
    cluster.edit(0, () => cluster.node(0, id!).state.t.insert(6, "1"));
    const [remote] = cluster.edit(1, () =>
      cluster.node(1, id!).state.t.insert(0, ">>"),
    );
    cluster.deliver(remote!, 0);
    cluster.edit(0, () => cluster.node(0, id!).state.t.insert(9, "2"));
    expect(cluster.text(0, id!)).toBe(">>abcdef12");
  });

  // Adapted from Yjs' y-text tests (testBasicInsertAndDelete).
  test("Y.Text basic insert and delete", () => {
    const { nodes } = paragraphs([""]);
    const t = nodes[0]!.state.t;
    t.insert(0, "abc");
    t.delete(0, 1);
    expect(t.get()).toBe("bc");
    t.delete(1, 1);
    expect(t.get()).toBe("b");
    t.insert(0, "z");
    t.insert(2, "y");
    expect(t.get()).toBe("zby");
    t.delete(0, 2);
    expect(t.get()).toBe("y");
  });

  // Adapted from diamond-types' list tests: deletes that span runs typed by
  // several agents, then typing where they were.
  test("deletes across other agents' runs, then typing in the gap", () => {
    const cluster = orderedCluster(["hello world"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(5, " big"));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(11, "!"));
    cluster.deliverAll();
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(3, 8));
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(3, "p, w"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("help, world!");
  });

  test("a lone high surrogate does not swallow the next character", () => {
    const { nodes } = paragraphs(["\uD83Da"]);
    const t = nodes[0]!.state.t;
    t.insert(1, "X");
    expect(t.get()).toBe("\uD83DXa");
  });
});
