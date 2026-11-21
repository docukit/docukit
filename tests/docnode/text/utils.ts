import {
  _INTERNAL_textStore,
  defineNode,
  defineText,
  Doc,
  type ChangeEvent,
  type DocConfig,
  type DocNode,
  type Json,
  type JsonDoc,
  type NodeIdGenerator,
  type Operations,
  type OperationsRow,
} from "@docukit/docnode";
import { _INTERNAL_crdtTextStore, labelsEngine } from "@docukit/docnode/crdt";
import { expect } from "vitest";

/**
 * Bold and italic go on with the letter typed after; a link only inside. A
 * paragraph letter (in flat texts) inherits nothing.
 */
const INHERIT = { bold: "origin", italic: "origin", link: "both" } as const;

export const Paragraph = defineNode({
  type: "p",
  state: { t: defineText({ inherit: INHERIT, opaque: "\x7f" }) },
});
export type ParagraphNode = DocNode<typeof Paragraph>;

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";

/**
 * Ids `<session>.<clock>`. Text ties are broken by session, so tests that
 * depend on a tie-break give each replica a session of known order.
 */
export function sessionIds(session: string): NodeIdGenerator {
  let clock = 0;
  return { generate: () => `${session}.${clock++}`, validate: () => true };
}

/**
 * The text of the CRDT mode (FugueMax), which converges in any order of
 * arrival: Base's relies on the server's (see `tests/docnode/baseText`).
 */
export const config = (
  undo = false,
  session?: string | NodeIdGenerator,
): DocConfig => ({
  type: "root",
  extensions: [{ nodes: [Paragraph] }],
  crdt: labelsEngine(),
  ...(undo ? { undoManager: { maxUndoSteps: 1000, mergeInterval: 0 } } : {}),
  ...(session
    ? {
        nodeIdGenerator:
          typeof session === "string" ? sessionIds(session) : session,
      }
    : {}),
});

const BASE64 =
  "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

/**
 * Ids shaped like the ones a document makes, `<session>.<clock>` with the
 * clock in base 64 digits, but of a fixed session: a history replays the same.
 */
function seededIds(session: string): NodeIdGenerator {
  let clock = 0;
  const digits = (n: number): string =>
    (n >= 64 ? digits(Math.floor(n / 64)) : "") + BASE64[n % 64];
  return {
    generate: () => `${session}.${digits(clock++)}`,
    validate: () => true,
  };
}

/**
 * `count` distinct sessions drawn from `seed`, shaped like the ones a document
 * makes (four to six base 64 digits), so their order varies from seed to seed
 * but a seed always replays the same history.
 */
export function seededSessions(seed: number, count: number): string[] {
  const rng = randomizer(seed ^ 0x5e55);
  const digits = [...BASE64];
  const sessions = new Set<string>();
  while (sessions.size < count) {
    let session = "";
    for (let i = 4 + rng.int(3); i > 0; i--) session += rng.pick(digits);
    sessions.add(session);
  }
  return [...sessions];
}

/** A small deterministic generator, so a failing seed can be replayed. */
export function randomizer(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)]!,
    shuffle: <T>(items: readonly T[]): T[] => {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [result[i], result[j]] = [result[j]!, result[i]!];
      }
      return result;
    },
  };
}
export type Randomizer = ReturnType<typeof randomizer>;

export type Spans = { text: string; attrs: Record<string, Json> }[];

export type Entry = { id: number; from: number; operations: Operations };

function createBase(
  paragraphs: string[],
  undo = false,
  session?: string | NodeIdGenerator,
) {
  const doc = new Doc({ ...config(undo, session), id: ROOT_ID });
  const ids: string[] = [];
  doc.forceCommit();
  for (const text of paragraphs) {
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, text);
    ids.push(node.id);
  }
  doc.forceCommit();
  return { json: doc.toJSON(), ids };
}

/** N replicas that start from the same snapshot and exchange text operations. */
export class Cluster {
  readonly docs: Doc[];
  readonly log: Entry[] = [];
  readonly ids: string[];
  readonly baseJson: JsonDoc;
  private readonly _delivered: Set<number>[];
  private readonly _config: (
    session?: string | NodeIdGenerator,
  ) => ReturnType<typeof config>;

  /**
   * With `sessions`, the base text uses session `r0` and replica `i` session
   * `r<i + 1>`, so ties between replicas always break in replica order. A list
   * names them instead: the base text's first, then each replica's, so a
   * history replays the same (see `seededSessions`).
   */
  constructor(
    paragraphs: string[],
    replicas: number,
    undo = false,
    sessions: boolean | readonly string[] = false,
  ) {
    const names =
      sessions === true
        ? Array.from({ length: replicas + 1 }, (_, index) => `r${index}`)
        : (sessions || []).map(seededIds);
    const { json, ids } = createBase(paragraphs, undo, names[0]);
    this.ids = ids;
    this.baseJson = json;
    this._config = (session) => config(undo, session);
    this.docs = Array.from({ length: replicas }, (_, replica) => {
      const doc = Doc.fromJSON(
        { ...this._config(names[replica + 1]), id: ROOT_ID },
        json,
      );
      doc.forceCommit();
      return doc;
    });
    this._delivered = this.docs.map(() => new Set());
  }

  /** A fresh replica built from this cluster's starting snapshot. */
  static replicate(cluster: Cluster): Doc {
    return Doc.fromJSON(
      { ...cluster._config(), id: ROOT_ID },
      cluster.baseJson,
    );
  }

  node(replica: number, id: string): ParagraphNode {
    const node = this.docs[replica]!.getNodeById(id);
    if (!node?.is(Paragraph))
      throw new Error(`no paragraph ${id} on ${replica}`);
    return node;
  }

  /** Runs a local edit and records what it produced as a deliverable entry. */
  edit(replica: number, edit: (doc: Doc) => void): Entry[] {
    const doc = this.docs[replica]!;
    const entries: Entry[] = [];
    const off = doc.onChange((event: ChangeEvent) => {
      const entry = {
        id: this.log.length,
        from: replica,
        operations: event.operations,
      };
      this.log.push(entry);
      this._delivered[replica]!.add(entry.id);
      entries.push(entry);
    });
    edit(doc);
    doc.forceCommit();
    off();
    return entries;
  }

  deliver(entry: Entry, to: number, duplicates = 1): void {
    for (let i = 0; i < duplicates; i++) {
      this.docs[to]!.applyOperations(entry.operations, { skipUndo: true });
      this.docs[to]!.forceCommit();
    }
    this._delivered[to]!.add(entry.id);
  }

  deliverAll(rng?: Randomizer, duplicates = 1): void {
    for (const [to] of this.docs.entries()) {
      const pending = this.log.filter(
        (entry) => !this._delivered[to]!.has(entry.id),
      );
      const ordered = rng ? rng.shuffle(pending) : pending;
      for (const entry of ordered) this.deliver(entry, to, duplicates);
    }
  }

  /** Delivers each entry a replica lacks with probability `share`. */
  deliverSome(rng: Randomizer, share: number): void {
    for (const [to] of this.docs.entries())
      for (const entry of rng.shuffle(this.log))
        if (!this._delivered[to]!.has(entry.id) && rng.next() < share)
          this.deliver(entry, to);
  }

  text(replica: number, id: string): string {
    return this.node(replica, id).state.t.get();
  }

  spans(replica: number, id: string): Spans {
    return this.node(replica, id).state.t.spans();
  }

  paragraphIds(replica: number): string[] {
    const ids: string[] = [];
    this.docs[replica]!.root.children().forEach((node) => ids.push(node.id));
    return ids;
  }

  store(replica: number): ReturnType<typeof _INTERNAL_crdtTextStore> {
    return _INTERNAL_crdtTextStore(this.docs[replica]!);
  }

  /** Visible text of every live paragraph, in document order. */
  texts(replica: number): string[] {
    return this.paragraphIds(replica).map((id) => this.text(replica, id));
  }

  /** Canonical text-state JSON, in document-independent form. */
  stateJson(replica: number): string {
    return JSON.stringify(this.docs[replica]!.toJSON());
  }

  assertConverged(): void {
    const first = this.texts(0);
    for (const [replica] of this.docs.entries()) {
      if (JSON.stringify(this.texts(replica)) !== JSON.stringify(first)) {
        throw new Error(
          `replica ${replica} texts diverged: ${JSON.stringify(this.texts(replica))} vs ${JSON.stringify(first)}`,
        );
      }
      const json = JSON.stringify(this.textStateOf(replica));
      if (json !== JSON.stringify(this.textStateOf(0))) {
        throw new Error(`replica ${replica} text state diverged`);
      }
    }
  }

  textStateOf(replica: number): unknown {
    return this.docs[replica]!.root.toJSON()[2];
  }
}

/**
 * Runs each edit in a transaction of its own, then checks that undoing them
 * one by one gives back each text before, and redoing them each text after.
 * It is what `checkUndoManager` checks of a Base document, read from the
 * text: a CRDT engine stores more than the text, and keeps it after an undo.
 */
export function checkTextUndo(doc: Doc, edits: (() => void)[]) {
  const view = () => {
    const spans: Spans[] = [];
    doc.root.children().forEach((node) => {
      if (node.is(Paragraph)) spans.push(node.state.t.spans());
    });
    return JSON.stringify(spans);
  };
  // A new document skips the undo of its first transaction.
  doc.forceCommit();
  const views = [view()];
  for (const edit of edits) {
    edit();
    doc.forceCommit();
    views.push(view());
  }
  for (let step = edits.length - 1; step >= 0; step--) {
    doc.undoManager.undo();
    doc.forceCommit();
    expect(view()).toBe(views[step]);
  }
  for (let step = 1; step <= edits.length; step++) {
    doc.undoManager.redo();
    doc.forceCommit();
    expect(view()).toBe(views[step]);
  }
}

/** Fails unless the string is well-formed UTF-16 (no lone surrogates). */
export function assertWellFormed(text: string): void {
  if (!text.isWellFormed())
    throw new Error(`lone surrogate in ${JSON.stringify(text)}`);
}

export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

/** A cluster whose ties break in replica order (see `Cluster`). */
export const orderedCluster = (
  paragraphs: string[],
  replicas: number,
  undo = false,
) => new Cluster(paragraphs, replicas, undo, true);

/** One document with a paragraph per text, committed and ready to edit. */
export function paragraphs(texts: string[], undo = false, session?: string) {
  const doc = new Doc(config(undo, session));
  const nodes = texts.map((text) => {
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, text);
    return node;
  });
  doc.forceCommit();
  return { doc, nodes };
}

/**
 * Joins `removed` into `target` with paragraphs as nodes: its letters are
 * inserted again at the end of `target` (new ids), and the node goes.
 */
export function backspaceJoin(target: ParagraphNode, removed: ParagraphNode) {
  let at = target.state.t.length;
  for (const span of removed.state.t.spans()) {
    target.state.t.insert(at, span.text, span.attrs);
    at += span.text.length;
  }
  removed.delete();
}

/**
 * Splits the paragraph at `index` with paragraphs as nodes: the tail is
 * deleted and inserted again in a new node. Returns the new node.
 */
export function enter(doc: Doc, node: ParagraphNode, index: number) {
  const fresh = doc.createNode(Paragraph);
  node.insertAfter(fresh);
  const text = node.state.t.get();
  let cursor = 0;
  let at = 0;
  for (const span of node.state.t.spans()) {
    const end = cursor + span.text.length;
    const piece = span.text.slice(Math.max(0, index - cursor));
    if (end > index && piece.length > 0) {
      fresh.state.t.insert(at, piece, span.attrs);
      at += piece.length;
    }
    cursor = end;
  }
  if (index < text.length) node.state.t.delete(index, text.length - index);
  return fresh;
}

/** The runs of each list of `doc` (see `TextStore._debugRuns`). */
/**
 * A batch of text edits from a session "z" no replica uses, on nodes of
 * another session: the head names both, and a node id `session.clock` is
 * written `1.clock` (see `wire.ts`).
 */
export const fromZ = (ids: string[], ...rows: OperationsRow[]): Operations => [
  ["z.-", ids[0]!.slice(0, ids[0]!.lastIndexOf("."))],
  ...rows,
];
export const inZ = (id: string) => `1${id.slice(id.lastIndexOf("."))}`;

export const runsOf = (doc: Doc) => _INTERNAL_textStore(doc)["_debugRuns"]();

/** A reloaded copy of `doc`, built from its stored form. */
export function reload(doc: Doc, session?: string): Doc {
  const copy = Doc.fromJSON(
    { ...config(false, session), id: doc.root.id },
    doc.toJSON(),
  );
  copy.forceCommit();
  return copy;
}

/**
 * Delivers `entry` to `to` and returns the paragraphs whose text or format
 * changed without being listed in the change event's diff.
 */
export function deliverUnreported(cluster: Cluster, entry: Entry, to: number) {
  const doc = cluster.docs[to]!;
  const before = new Map(
    cluster
      .paragraphIds(to)
      .map((id) => [id, JSON.stringify(cluster.spans(to, id))]),
  );
  const updated = new Set<string>();
  const off = doc.onChange(({ diff }) => {
    for (const id of diff.updated) updated.add(id);
  });
  cluster.deliver(entry, to);
  off();
  return [...before].flatMap(([id, spans]) =>
    doc.getNodeById(id) &&
    JSON.stringify(cluster.spans(to, id)) !== spans &&
    !updated.has(id)
      ? [id]
      : [],
  );
}

/**
 * `replicas` replicas type at once in one paragraph, mostly at its start and
 * end, in rounds that each deliver only part of what was sent: many letters
 * become siblings of the same element, some with different right origins.
 */
export function crowdTyping(seed: number, replicas: number, rounds: number) {
  const rng = randomizer(seed);
  const cluster = orderedCluster(["ab"], replicas);
  const id = cluster.ids[0]!;
  for (let round = 0; round < rounds; round++) {
    for (let replica = 0; replica < replicas; replica++)
      cluster.edit(replica, () => {
        const text = cluster.node(replica, id).state.t;
        const length = text.get().length;
        const index = rng.pick([0, 0, length, length, rng.int(length + 1)]);
        if (index < length && rng.next() < 0.15) text.delete(index, 1);
        else text.insert(index, String.fromCharCode(97 + (replica % 26)));
      });
    cluster.deliverSome(rng, 0.3);
  }
  return cluster;
}

/** The paragraph's text on a fresh replica that receives the log in `order`. */
export function textAfter(cluster: Cluster, order: Entry[]): string {
  const doc = Cluster.replicate(cluster);
  for (const entry of order) {
    doc.applyOperations(entry.operations, { skipUndo: true });
    doc.forceCommit();
  }
  const node = doc.getNodeById(cluster.ids[0]!);
  return node?.is(Paragraph) ? node.state.t.get() : "";
}
