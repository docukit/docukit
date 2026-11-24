import {
  _INTERNAL_textStore,
  mergeBatches,
  defineNode,
  defineText,
  Doc,
  type DocNode,
  type Json,
  type JsonDoc,
  type NodeIdGenerator,
  type Operations,
  rebase,
  type TextSpan,
} from "@docukit/docnode";

/**
 * Base's text (see `BaseText`): it relies on the server's order. Bold and
 * italic go on with the letter typed after; a link only inside. A paragraph
 * letter (the end of a line) inherits nothing.
 */
export const P = "\x7f";
const TEXT = {
  inherit: { bold: "origin", italic: "origin", link: "both" },
  opaque: P,
} as const;

/** A root with a flat text: a line per paragraph letter, as in Lexical. */
export const Root = defineNode({
  type: "root",
  state: { t: defineText(TEXT) },
});
export const Paragraph = defineNode({
  type: "p",
  state: { t: defineText(TEXT) },
});
export type ParagraphNode = DocNode<typeof Paragraph>;

export const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";

/** Ids `<session>.<clock>` (a node id without a dot has no session). */
export function sessionIds(session: string, dot = "."): NodeIdGenerator {
  let clock = 0;
  return { generate: () => `${session}${dot}${clock++}`, validate: () => true };
}

/** With the default ids: `checkUndoManager` checks their form. */
export const defaultConfig = () => ({
  type: "root",
  extensions: [{ nodes: [Root, Paragraph] }],
  undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
});

export const config = (session = "a", dot = ".") => ({
  type: "root",
  extensions: [{ nodes: [Root, Paragraph] }],
  undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
  nodeIdGenerator: sessionIds(session, dot),
});

export const rootText = (doc: Doc) => {
  const root = doc.root;
  if (!root.is(Root)) throw new Error("Expected the root");
  return root.state.t;
};

export type Text = ReturnType<typeof rootText>;

/** A document whose root text is `text`, committed and ready to edit. */
export function flat(text = "", session = "a") {
  const doc = new Doc({ ...config(session), id: ROOT_ID });
  doc.forceCommit();
  rootText(doc).insert(0, text);
  doc.forceCommit();
  return { doc, text: rootText(doc) };
}

/** The batches `edit` sends, one per transaction it commits. */
export function sent(doc: Doc, edit: () => void): Operations[] {
  const out: Operations[] = [];
  const off = doc.onChange((event) => {
    if (!event.flags.skipUndo) out.push(event.operations);
  });
  edit();
  doc.forceCommit();
  off();
  return out;
}

/** What a remote batch does to `doc`, as DocSync applies it. */
export function receive(doc: Doc, ...batches: Operations[]) {
  for (const batch of batches) doc.applyOperations(batch, { skipUndo: true });
  doc.forceCommit();
}

/** A copy of `doc` loaded from what it stores. */
export function reload(doc: Doc, session = "r") {
  const copy = Doc.fromJSON(
    { ...config(session), id: doc.root.id },
    doc.toJSON(),
  );
  copy.forceCommit();
  return copy;
}

export const stored = (doc: Doc) => JSON.stringify(doc.toJSON());

/** The runs of each list of `doc`, in order (see `BaseText._debugRuns`). */
export const runsOf = (doc: Doc) => _INTERNAL_textStore(doc)["_debugRuns"]();

/** Spans of `text`, as `"letters:attrs"` strings, easier to read. */
export const styled = (spans: TextSpan[]) =>
  spans.map(({ text, attrs }) =>
    Object.keys(attrs).length === 0 ? text : `${text}:${JSON.stringify(attrs)}`,
  );

type Replica = {
  readonly session: string;
  doc: Doc;
  /** Batches made here the server has not ordered yet. */
  pending: Operations[];
  /** Batches made here the server ordered, before it synced again. */
  sent: Set<Operations>;
  /** How many batches of the server's log it applied. */
  seen: number;
  /** Docs it held: each new one has a new session, as default ids do. */
  generation: number;
};

/**
 * Replicas of a root text that sync through a server, as DocSync does: each
 * applies its own edits at once; the server orders batches as they reach it.
 * A replica that receives batches while its own ones are pending takes the
 * server's document and applies its pending ones again (`replaceDoc`), with
 * its undo history. From then on it rebases in place instead (`rebase`),
 * into the same document a replacement would be, until it reloads.
 */
export class Network {
  readonly server: Doc;
  readonly log: Operations[] = [];
  private readonly _replicas = new Map<string, Replica>();

  constructor(text: string, sessions: string[]) {
    this.server = flat(text, "s").doc;
    const json = this.server.toJSON();
    for (const session of sessions) {
      const replica: Replica = {
        session,
        doc: this._load(`${session}0`, json),
        pending: [],
        sent: new Set(),
        seen: 0,
        generation: 0,
      };
      this._replicas.set(session, replica);
    }
  }

  private _load(session: string, json: JsonDoc): Doc {
    const doc = Doc.fromJSON({ ...config(session), id: ROOT_ID }, json);
    doc.forceCommit();
    return doc;
  }

  private _replica(session: string): Replica {
    return this._replicas.get(session)!;
  }

  doc(session: string): Doc {
    return this._replica(session).doc;
  }

  text(session: string): Text {
    return rootText(this.doc(session));
  }

  /** A local edit of `session`, committed: its batch waits to be sent. */
  edit(session: string, edit: (text: Text, doc: Doc) => void): Operations[] {
    const replica = this._replica(session);
    const batches = sent(replica.doc, () =>
      edit(rootText(replica.doc), replica.doc),
    );
    replica.pending.push(...batches);
    return batches;
  }

  undo(session: string) {
    return this.edit(session, (_text, doc) => doc.undoManager.undo());
  }

  redo(session: string) {
    return this.edit(session, (_text, doc) => doc.undoManager.redo());
  }

  /**
   * The server orders what `session` has pending, after what it has.
   * `merge`: the replica merges it first, as DocSync does before a push.
   * `twice`: the server orders it twice, as DocSync's does when a push is
   * sent again (it does not drop batches it has).
   */
  send(session: string, { merge = false, twice = false } = {}): void {
    const replica = this._replica(session);
    const batches = merge ? mergeBatches(replica.pending) : replica.pending;
    for (const batch of twice ? [...batches, ...batches] : batches) {
      this.log.push(batch);
      replica.sent.add(batch);
      receive(this.server, batch);
    }
    replica.pending = [];
  }

  /** `session` loads what its document stores, with its undo history. */
  reload(session: string): void {
    const replica = this._replica(session);
    const history = replica.doc.undoManager.exportHistory();
    const next = this._load(
      `${replica.session}${++replica.generation}`,
      replica.doc.toJSON(),
    );
    next.undoManager.importHistory(history);
    replica.doc.dispose();
    replica.doc = next;
  }

  /** `session` takes what the server ordered since it last synced. */
  sync(session: string): void {
    const replica = this._replica(session);
    const fresh = this.log.slice(replica.seen);
    if (fresh.length === 0) {
      // Nothing new.
    } else if (rebase(replica.doc, fresh)) {
      receive(replica.doc, ...replica.pending);
      const replacement = this._load("check", this.server.toJSON());
      receive(replacement, ...replica.pending);
      if (stored(replica.doc) !== stored(replacement))
        throw new Error(`${replica.session} rebased into another document`);
    } else if (replica.sent.size === 0 && replica.pending.length === 0) {
      receive(replica.doc, ...fresh);
    } else {
      // Its own batches went to the server in the meantime, maybe after
      // others or twice: the server's document, then what it did since.
      const history = replica.doc.undoManager.exportHistory();
      const next = this._load(
        `${replica.session}${++replica.generation}`,
        this.server.toJSON(),
      );
      rebase(next);
      receive(next, ...replica.pending);
      next.undoManager.importHistory(history);
      replica.doc.dispose();
      replica.doc = next;
    }
    replica.seen = this.log.length;
    replica.sent.clear();
  }

  get sessions(): string[] {
    return [...this._replicas.keys()];
  }

  /** Everyone sends, in order, then everyone syncs. */
  exchange(): void {
    for (const session of this._replicas.keys()) this.send(session);
    for (const session of this._replicas.keys()) this.sync(session);
  }

  /** The text of every replica, which must be the server's. */
  converged(): TextSpan[] {
    const spans = rootText(this.server).spans();
    for (const replica of this._replicas.values())
      if (
        JSON.stringify(rootText(replica.doc).spans()) !==
          JSON.stringify(spans) ||
        stored(replica.doc) !== stored(this.server)
      )
        throw new Error(`${replica.session} diverged from the server`);
    return spans;
  }
}

/** The text a new network shows after `edits`, in that order of sending. */
export function race(
  text: string,
  edits: Record<string, (text: Text) => void>,
  order: string[],
): TextSpan[] {
  const network = new Network(text, Object.keys(edits));
  for (const [session, edit] of Object.entries(edits))
    network.edit(session, edit);
  for (const session of order) network.send(session);
  for (const session of order) network.sync(session);
  return network.converged();
}

/** `attrs` as the attrs of a span, `{}` when none. */
export const attrs = (values: Record<string, Json> = {}) => values;
