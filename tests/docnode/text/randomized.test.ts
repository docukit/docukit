import { Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import {
  assertWellFormed,
  Cluster,
  config,
  Paragraph,
  randomizer,
  seededSessions,
  type Randomizer,
} from "./utils.js";

const SEEDS = Number(process.env.TEXT_FUZZ_SEEDS ?? 60);
const VERBOSE = process.env.TEXT_FUZZ_VERBOSE === "1";

const alphabet = ["a", "b", "c", "x", "yz", "😀", " "];
/** The letter that ends a paragraph in a flat text. */
const PARAGRAPH = "\x7f";

type Stats = {
  histories: number;
  converged: number;
  lost: number;
  strongViolations: number;
  interleavings: number;
  idOrderViolations: number;
};

function randomEdit(
  cluster: Cluster,
  replica: number,
  rng: Randomizer,
  doc: Doc,
  undo: boolean,
) {
  const ids = cluster.paragraphIds(replica);
  if (ids.length === 0) return;
  const node = cluster.node(replica, rng.pick(ids));
  const text = node.state.t.get();
  const roll = rng.next();
  if (roll < 0.4) {
    // Typed with the attributes of the text around it, or bold, or none.
    const at = rng.int(text.length + 1);
    const around = node.state.t.spans().find((_span, index, spans) => {
      let end = 0;
      for (const span of spans.slice(0, index + 1)) end += span.text.length;
      return end >= at;
    })?.attrs;
    const pick = rng.next();
    const attrs = pick < 0.4 ? around : pick < 0.6 ? { bold: true } : undefined;
    node.state.t.insert(at, rng.pick(alphabet), attrs);
  } else if (roll < 0.6 && text.length > 0) {
    const start = rng.int(text.length);
    node.state.t.delete(start, Math.min(1 + rng.int(4), text.length - start));
  } else if (roll < 0.72 && text.length > 1) {
    const start = rng.int(text.length - 1);
    const end = start + 1 + rng.int(text.length - start - 1);
    const key = rng.pick(["bold", "italic", "link"]);
    const value =
      key === "link"
        ? `https://${rng.int(3)}`
        : rng.next() < 0.75
          ? true
          : null;
    node.state.t.format(start, end, key, value);
  } else if (roll < 0.82) {
    // Enter: a paragraph letter, in the same text.
    node.state.t.insert(rng.int(text.length + 1), PARAGRAPH, { h: rng.int(3) });
  } else if (roll < 0.9 && text.includes(PARAGRAPH)) {
    // Backspace at the start of a line: its paragraph letter goes.
    const ends = [...text].flatMap((char, index) =>
      char === PARAGRAPH ? [index] : [],
    );
    node.state.t.delete(rng.pick(ends), 1);
  } else if (!undo) {
    return;
  } else if (roll < 0.97) {
    doc.undoManager.undo();
  } else {
    doc.undoManager.redo();
  }
}

/**
 * One random concurrent history, with partial delivery in the middle. Returns
 * the cluster after everyone has received everything.
 */
function runHistory(
  seed: number,
  deliveries: "any-order" | "server-order",
  undo = false,
) {
  const rng = randomizer(seed);
  // Sessions from the seed: a failing seed replays the same history.
  const cluster = new Cluster(
    ["Hello world", "Second 😀 line."],
    3,
    true,
    seededSessions(seed, 4),
  );
  const steps = 15 + rng.int(40);
  const snapshots: { replica: number; views: Record<string, string[]> }[] = [];
  for (let step = 0; step < steps; step++) {
    const replica = rng.int(3);
    cluster.edit(replica, (doc) =>
      randomEdit(cluster, replica, rng, doc, undo),
    );
    if (rng.next() < 0.2)
      snapshots.push({
        replica,
        views: cluster.store(replica)["_debugViews"](),
      });
    if (cluster.log.length > 0 && rng.next() < 0.25) {
      const entry = rng.pick(cluster.log);
      const to = rng.int(3);
      if (entry.from !== to)
        cluster.deliver(entry, to, rng.next() < 0.3 ? 2 : 1);
    }
  }
  if (deliveries === "any-order") cluster.deliverAll(rng, 1 + rng.int(2));
  else cluster.deliverAll(undefined, 1);
  return { cluster, snapshots };
}

/** The stored form is lossless and a reloaded replica keeps merging. */
function reloadKeepsState(cluster: Cluster, expected: string): boolean {
  const reloaded = Doc.fromJSON(
    { ...config(true), id: cluster.docs[0]!.root.id },
    cluster.docs[0]!.toJSON(),
  );
  reloaded.forceCommit();
  // What it shows, inherited attributes included, before the log too.
  const spansOf = (doc: Doc) =>
    JSON.stringify(
      cluster
        .paragraphIds(0)
        .map((id) => doc.getNodeById(id))
        .map((node) => (node?.is(Paragraph) ? node.state.t.spans() : null)),
    );
  if (spansOf(reloaded) !== spansOf(cluster.docs[0]!)) return false;
  for (const entry of cluster.log)
    reloaded.applyOperations(entry.operations, { skipUndo: true });
  reloaded.forceCommit();
  return JSON.stringify(reloaded.root.toJSON()[2]) === expected;
}

function analyze(
  cluster: Cluster,
  snapshots: { views: Record<string, string[]> }[],
  stats: Stats,
) {
  stats.histories++;
  const first = JSON.stringify(cluster.textStateOf(0));
  let ok = true;
  for (let replica = 1; replica < cluster.docs.length; replica++) {
    if (JSON.stringify(cluster.textStateOf(replica)) !== first) ok = false;
  }
  // Nodes present on every replica must show the same text.
  const ids = new Set(
    cluster.docs.flatMap((_, replica) => cluster.paragraphIds(replica)),
  );
  for (const id of ids) {
    const texts = cluster.docs.map((doc, replica) =>
      doc.getNodeById(id) ? cluster.text(replica, id) : null,
    );
    const present = texts.filter((text) => text !== null);
    for (const text of present) assertWellFormed(text);
    if (new Set(present).size > 1) ok = false;
    // And the same attributes, inherited ones included.
    const spans = cluster.docs.flatMap((doc, replica) =>
      doc.getNodeById(id) ? [JSON.stringify(cluster.spans(replica, id))] : [],
    );
    if (new Set(spans).size > 1) ok = false;
  }
  if (!reloadKeepsState(cluster, first)) ok = false;
  if (ok) stats.converged++;

  const store = cluster.store(0);
  const elements = store["_debugElements"]();
  const position = new Map(
    elements.map((element, index) => [element.id, index]),
  );
  // Characters typed by someone that nobody deleted must stay visible.
  stats.lost += elements.filter(
    (element) => !element.deleted && !element.visible,
  ).length;
  // Attiya et al. strong list specification: every observed visible order is
  // consistent with the single final order of all elements.
  for (const { views } of snapshots) {
    for (const ids of Object.values(views)) {
      let last = -1;
      for (const id of ids) {
        const at = position.get(id);
        if (at === undefined) continue;
        if (at < last) stats.strongViolations++;
        last = at;
      }
    }
  }
  // Fugue Definition 4, conditions (1) and (3), over text elements.
  const byLeftOrigin = new Map<string, string[]>();
  for (const element of elements) {
    if (element.leftOrigin === undefined) continue;
    const list = byLeftOrigin.get(element.leftOrigin) ?? [];
    list.push(element.id);
    byLeftOrigin.set(element.leftOrigin, list);
  }
  for (const [origin, children] of byLeftOrigin) {
    const earliest = children.reduce((best, id) =>
      position.get(id)! < position.get(best)! ? id : best,
    );
    const at = position.get(origin);
    if (at === undefined) continue;
    const next = elements[at + 1];
    if (next && next.id !== earliest) stats.interleavings++;
  }
  const groups = new Map<string, string[]>();
  for (const element of elements) {
    if (element.leftOrigin === undefined || element.rightOrigin === undefined)
      continue;
    const key = `${element.leftOrigin}|${element.rightOrigin}`;
    const list = groups.get(key) ?? [];
    list.push(element.id);
    groups.set(key, list);
  }
  for (const members of groups.values()) {
    const sorted = [...members].sort(
      (a, b) => position.get(a)! - position.get(b)!,
    );
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1]! > sorted[i]!) stats.idOrderViolations++;
    }
  }
}

function report(label: string, stats: Stats) {
  if (VERBOSE) console.log(label, JSON.stringify(stats));
}

function empty(): Stats {
  return {
    histories: 0,
    converged: 0,
    lost: 0,
    strongViolations: 0,
    interleavings: 0,
    idOrderViolations: 0,
  };
}

/**
 * The seeds of a test. Every hundred, the microtasks run: each new document
 * queues one that holds it, and thousands of histories in one synchronous
 * loop would keep every document in memory until the test ends.
 */
async function* seeds() {
  for (let seed = 0; seed < SEEDS; seed++) {
    if (seed % 100 === 99) await Promise.resolve();
    yield seed;
  }
}

/**
 * Every edit commutes, undo included (an undo of a delete inserts new
 * letters): replicas converge whatever the order.
 */
describe("randomized concurrent histories", () => {
  test(
    `any delivery order, duplicates (${SEEDS} histories)`,
    { timeout: Math.max(8000, SEEDS * 20) },
    async () => {
      const stats = empty();
      for await (const seed of seeds()) {
        const { cluster, snapshots } = runHistory(1000 + seed, "any-order");
        analyze(cluster, snapshots, stats);
        if (stats.converged !== stats.histories)
          throw new Error(`seed ${seed} diverged`);
      }
      report("any-order", stats);
      expect(stats.converged).toBe(stats.histories);
      expect(stats.lost).toBe(0);
      expect(stats.strongViolations).toBe(0);
      expect(stats.interleavings).toBe(0);
      expect(stats.idOrderViolations).toBe(0);
    },
  );

  test(
    `with undo, any delivery order, duplicates (${SEEDS} histories)`,
    { timeout: Math.max(8000, SEEDS * 20) },
    async () => {
      const stats = empty();
      for await (const seed of seeds()) {
        const { cluster, snapshots } = runHistory(
          3000 + seed,
          "any-order",
          true,
        );
        analyze(cluster, snapshots, stats);
        if (stats.converged !== stats.histories)
          throw new Error(`seed ${seed} diverged`);
      }
      report("undo any-order", stats);
      expect(stats.lost).toBe(0);
      expect(stats.strongViolations).toBe(0);
    },
  );

  test(
    `text state matches a replay in server order (${SEEDS} histories)`,
    { timeout: Math.max(8000, SEEDS * 20) },
    async () => {
      const stats = empty();
      for await (const seed of seeds()) {
        const { cluster } = runHistory(9000 + seed, "any-order");
        // A fresh replica replaying the whole log, in log order, must reach the
        // same text state as every live replica that got it in any order.
        const replay = new Cluster([], 0, true);
        replay.docs.push(Cluster.replicate(cluster));
        for (const entry of cluster.log)
          replay.docs[0]!.applyOperations(entry.operations, { skipUndo: true });
        replay.docs[0]!.forceCommit();
        expect(JSON.stringify(replay.textStateOf(0))).toBe(
          JSON.stringify(cluster.textStateOf(0)),
        );
        stats.histories++;
        stats.converged++;
      }
      report("replay", stats);
    },
  );

  test(
    `with undo, the log applied again changes nothing, also after a reload (${SEEDS} histories)`,
    { timeout: Math.max(8000, SEEDS * 20) },
    async () => {
      for await (const seed of seeds()) {
        const { cluster } = runHistory(5000 + seed, "server-order", true);
        // A replica that replays the whole log in the server's order, as a
        // DocSync server does, then gets it again, as a client applies its
        // pending operations again on a snapshot that may have them.
        const replay = new Cluster([], 0, true);
        replay.docs.push(Cluster.replicate(cluster));
        const doc = replay.docs[0]!;
        const applyLog = (target: Doc) => {
          for (const entry of cluster.log)
            target.applyOperations(entry.operations, { skipUndo: true });
          target.forceCommit();
        };
        applyLog(doc);
        const state = JSON.stringify(replay.textStateOf(0));
        applyLog(doc);
        expect(JSON.stringify(replay.textStateOf(0))).toBe(state);
        const reloaded = Doc.fromJSON(
          { ...config(true), id: doc.root.id },
          doc.toJSON(),
        );
        reloaded.forceCommit();
        applyLog(reloaded);
        expect(JSON.stringify(reloaded.root.toJSON()[2])).toBe(
          JSON.stringify(doc.root.toJSON()[2]),
        );
      }
    },
  );
});
