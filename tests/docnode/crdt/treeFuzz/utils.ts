import { expect, test } from "vitest";
import {
  Doc,
  defineNode,
  string,
  type DocNode,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import { labelsEngine, labelsSnapshot } from "@docukit/docnode/crdt";

const ROOT_ID = "01jz0000000000000000000000";

const Item = defineNode({ type: "n", state: { v: string(""), w: string("") } });

/** How a history is played: replicas, duplicates, and crashes. */
type Setup = {
  peers: number;
  steps: number;
  duplicates: number;
  /** A replica may reload from what it stored. */
  reload: boolean;
  /** After a reload, it sends its state again, as after a crash. */
  resend: boolean;
};

const SETUP: Setup = {
  peers: 3,
  steps: 150,
  duplicates: 0.3,
  reload: false,
  resend: false,
};

/** A small deterministic generator, so a failing seed can be replayed. */
function randomizer(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Item = DocNode<typeof Item>;

function items(doc: Doc) {
  const out: Item[] = [];
  const walk = (node: DocNode) =>
    node.children().forEach((child) => {
      if (child.is(Item)) out.push(child);
      walk(child);
    });
  walk(doc.root);
  return out;
}

/** The tree with each node's state, the same on replicas that converged. */
function view(doc: Doc): string {
  const write = (node: DocNode): string => {
    const children: string[] = [];
    node.children().forEach((child) => children.push(write(child)));
    const state = node.is(Item)
      ? `{${node.state.v.get()},${node.state.w.get()}}`
      : "";
    return `${node.id}${state}[${children.join(",")}]`;
  };
  return write(doc.root);
}

/** One random edit, or the delivery of a message. */
function step(
  doc: Doc,
  roll: () => number,
  deliver: (pick: number, to: number) => void,
  reload: () => void,
) {
  const [kind, a, b, c] = [roll(), roll(), roll(), roll()];
  const nodes = items(doc);
  const pick = (x: number) => nodes[Math.floor(x * nodes.length)]!;
  if (kind < 0.12 || nodes.length === 0) {
    const node = doc.createNode(Item);
    node.state.v.set(`i${Math.floor(a * 1000)}`);
    const target = nodes.length > 0 ? pick(b) : undefined;
    if (!target || c < 0.3) doc.root.append(node);
    else if (c < 0.5) target.append(node);
    else if (c < 0.75) target.insertBefore(node);
    else target.insertAfter(node);
  } else if (kind < 0.2) {
    pick(a).delete();
  } else if (kind < 0.25) {
    const first = pick(a);
    let last: DocNode = first;
    for (let i = 0; i < Math.floor(b * 3) && last.next; i++) last = last.next;
    first.to(last).delete();
  } else if (kind < 0.4) {
    const node = pick(a);
    const target = pick(b);
    for (let up: DocNode | undefined = target; up; up = up.parent)
      if (up === node) return;
    node.move(target, c < 0.3 ? "append" : c < 0.65 ? "before" : "after");
  } else if (kind < 0.5) {
    const node = pick(a);
    const value = `s${Math.floor(b * 1000)}`;
    if (c < 0.5) node.state.v.set(value);
    else node.state.w.set(value);
  } else if (kind < 0.56) {
    doc.undoManager.undo();
  } else if (kind < 0.59) {
    doc.undoManager.redo();
  } else if (kind < 0.6) {
    reload();
    return;
  } else {
    deliver(a, b);
    return;
  }
  doc.forceCommit();
}

/**
 * A random history on `setup.peers` replicas, then every message delivered
 * everywhere in a random order, with repeats. `undefined` if every replica
 * shows the same tree and delivering everything again changes nothing they
 * store; else what went wrong.
 */
function playHistory(seed: number, setup = SETUP) {
  const config = (peer: string, clock: { next: number }) => ({
    type: "root",
    extensions: [{ nodes: [Item] }],
    undoManager: { maxUndoSteps: 1000, mergeInterval: 0 },
    crdt: labelsEngine(),
    nodeIdGenerator: {
      generate: () => `${peer}.${clock.next++}`,
      validate: () => true,
    },
  });
  const genesis = new Doc({ ...config("g", { next: 0 }), id: ROOT_ID });
  genesis.forceCommit();
  for (let i = 0; i < 4; i++) genesis.root.append(genesis.createNode(Item));
  genesis.forceCommit();
  const base = genesis.toJSON();
  const clocks = Array.from({ length: setup.peers }, () => ({ next: 0 }));
  const log: Operations[] = [];
  const seen = clocks.map(() => new Set<number>());
  const docs: Doc[] = [];
  const open = (peer: number, json: JsonDoc) => {
    const doc = Doc.fromJSON(
      { ...config(`p${peer}`, clocks[peer]!), id: ROOT_ID },
      json,
    );
    doc.forceCommit();
    doc.onChange((event) => {
      if (event.flags.skipUndo) return;
      seen[peer]!.add(log.length);
      log.push(structuredClone(event.operations));
    });
    docs[peer] = doc;
  };
  clocks.forEach((_, peer) => open(peer, base));
  const deliver = (message: number, to: number) => {
    docs[to]!.applyOperations(structuredClone(log[message]!), {
      skipUndo: true,
    });
    docs[to]!.forceCommit();
    seen[to]!.add(message);
  };
  const roll = randomizer(seed);
  for (let index = 0; index < setup.steps; index++) {
    const peer = Math.floor(roll() * 10) % setup.peers;
    step(
      docs[peer]!,
      roll,
      (pick, to) => {
        if (log.length === 0) return;
        const message = Math.floor(pick * log.length);
        const target = Math.floor(to * setup.peers);
        deliver(message, target);
        if (roll() < setup.duplicates) deliver(message, target);
      },
      () => {
        if (!setup.reload) return;
        open(peer, docs[peer]!.toJSON());
        if (!setup.resend) return;
        // What a replica that crashed sends again: its whole document.
        seen[peer]!.add(log.length);
        log.push(labelsSnapshot(docs[peer]!.toJSON()));
      },
    );
  }
  const order = randomizer(setup.steps + 7);
  for (let round = 0; round < 2; round++) {
    docs.forEach((_, to) => {
      const shuffled = log.map((_, i) => i).sort(() => order() - 0.5);
      for (const message of shuffled)
        if (!seen[to]!.has(message) || order() < setup.duplicates)
          deliver(message, to);
    });
  }
  const views = docs.map(view);
  if (new Set(views).size > 1) return { diverged: views };
  const stored = docs.map((doc) => JSON.stringify(doc.toJSON()));
  docs.forEach((_, to) => log.forEach((_, message) => deliver(message, to)));
  const again = docs.map((doc) => JSON.stringify(doc.toJSON()));
  if (again.some((json, peer) => json !== stored[peer]))
    return { changedOnRepeat: again };
  return undefined;
}

const SEEDS = Number(process.env.TREE_FUZZ_SEEDS ?? 100);

const SETUPS = {
  plain: SETUP,
  reload: { ...SETUP, reload: true },
  "crash and resend": { ...SETUP, reload: true, resend: true, peers: 4 },
};

type SetupName = keyof typeof SETUPS;

/**
 * Seeds that diverged, changed on a repeat or threw before their fixes (with
 * this engine or the ones it replaced), and one where a local delete meets a
 * later pointer a remote delete saw (78).
 */
const REGRESSIONS: [SetupName, number][] = [
  ["plain", 148],
  ["plain", 296],
  ["reload", 103],
  ["reload", 135],
  ["crash and resend", 118],
  ["crash and resend", 152],
  ["crash and resend", 279],
  ["crash and resend", 372],
];

/** `[seed, what failed]` for each seed whose history did not converge. */
const failures = (seeds: number[], setup: SetupName) =>
  seeds.flatMap((seed) => {
    const failure = playHistory(seed, SETUPS[setup]);
    return failure ? [[seed, Object.keys(failure)[0]]] : [];
  });

const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1);

/**
 * Random histories played one way, and the seeds of that way that once
 * failed. Each way is its own file, so they run in parallel.
 */
export function fuzzTrees(setup: SetupName) {
  test(
    `${SEEDS} random trees converge, and repeats change nothing (${setup})`,
    { timeout: Math.max(2000, SEEDS * 40) },
    () => {
      expect(failures(range(SEEDS), setup)).toStrictEqual([]);
    },
  );

  const regressions = REGRESSIONS.filter(([way]) => way === setup);
  test.each(regressions)("%s, seed %i converges", (way, seed) => {
    expect(failures([seed], way)).toStrictEqual([]);
  });
}
