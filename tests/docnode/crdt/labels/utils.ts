import {
  Doc,
  type DocNode,
  type Json,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import { labelsEngine, type LabelsOptions } from "@docukit/docnode/crdt";
import { expect } from "vitest";

import { Text, TextExtension } from "../../utils.js";
import { Paragraph, sessionIds, type ParagraphNode } from "../../text/utils.js";

export const ROOT_ID = "01jz0000000000000000000000";

export type Replica = ReturnType<typeof createReplica>;

export function createReplica(
  options: LabelsOptions & {
    peer: string;
    normalizeRoot?: boolean;
    plainIds?: boolean;
    /** The ids it gives its first nodes, before `peer.counter` ones. */
    ids?: string[];
  },
) {
  const { peer, normalizeRoot, plainIds, ids = [], ...engine } = options;
  let counter = 0;
  // A new Doc runs normalize once: each replica would invent its own node.
  let armed = false;
  const extension = {
    nodes: [Text],
    ...(normalizeRoot
      ? {
          register: (doc: Doc) => {
            doc.onNormalize(() => {
              if (armed && !doc.root.first) {
                doc.root.append(doc.createNode(Text));
              }
            });
          },
        }
      : {}),
  };
  const doc = new Doc({
    id: ROOT_ID,
    type: "root",
    extensions: [extension],
    undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
    crdt: labelsEngine(engine),
    nodeIdGenerator: {
      generate: () =>
        ids.shift() ??
        (plainIds ? `${peer}${counter++}` : `${peer}.${counter++}`),
      validate: () => true,
    },
  });
  doc.forceCommit();
  armed = true;
  return attach(doc, peer);
}

function attach(doc: Doc, peer: string) {
  const outbox: Operations[] = [];
  doc.onChange((event) => {
    if (!event.flags?.skipUndo) outbox.push(event.operations);
  });
  return { doc, peer, outbox };
}

/** A new replica built from another replica's persisted JSON. */
export function restoreReplica(
  from: Replica,
  peer: string,
  options: LabelsOptions = {},
) {
  const doc = Doc.fromJSON(
    {
      type: "root",
      id: from.doc.root.id,
      extensions: [TextExtension],
      undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
      crdt: labelsEngine(options),
      nodeIdGenerator: { generate: () => `${peer}.r`, validate: () => true },
    },
    from.doc.toJSON(),
  );
  doc.forceCommit();
  return attach(doc, peer);
}

export function take(replica: Replica) {
  return replica.outbox.splice(0);
}

export function deliver(replica: Replica, operations: Operations[]) {
  for (const operation of operations) {
    replica.doc.applyOperations(structuredClone(operation), { skipUndo: true });
    replica.doc.forceCommit();
  }
}

/** Delivers everything that happened to every other replica, including the repairs. */
export function syncAll(...replicas: Replica[]) {
  const pending = replicas.map(take);
  replicas.forEach((replica, position) => {
    pending.forEach((operations, source) => {
      if (position !== source) deliver(replica, operations);
    });
  });
}

export function insert(replica: Replica, parent: DocNode, value: string) {
  const node = replica.doc.createNode(Text);
  node.state.value.set(value);
  parent.append(node);
  replica.doc.forceCommit();
  return node;
}

export function tree(replica: Replica) {
  const render = (node: DocNode): string => {
    const value = node.is(Text) ? node.state.value.get() : "root";
    const children: string[] = [];
    node.children().forEach((child) => children.push(render(child)));
    return children.length ? `${value}(${children.join(",")})` : value;
  };
  return render(replica.doc.root);
}

export function expectSameTree(...replicas: Replica[]) {
  const [first, ...rest] = replicas;
  for (const replica of rest) expect(tree(replica)).toBe(tree(first!));
}

const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

/** The sections of the labels a document stores (see `StoredLabels`). */
export function storedLabels(doc: Doc) {
  const stored = doc.toJSON().at(-1);
  const [, , deleted, rootStamps, , extras, limbo, aliases, pending] = isList(
    stored,
  )
    ? stored
    : [];
  const items = (section: Json | undefined) =>
    isList(section) ? section.length : 0;
  return {
    extras,
    deleted,
    rootStamps,
    limbo: items(limbo),
    aliases: items(aliases),
    pending: items(pending),
  };
}

export const value = (node: DocNode) =>
  node.is(Text) ? node.state.value.get() : "";

/** A replica of paragraphs of text named `session`, loaded from `json`. */
function createTextPeer(session: string, json: JsonDoc) {
  const doc = Doc.fromJSON(
    {
      type: "root",
      id: ROOT_ID,
      extensions: [{ nodes: [Paragraph] }],
      nodeIdGenerator: sessionIds(session),
      crdt: labelsEngine(),
    },
    json,
  );
  doc.forceCommit();
  const paragraphs = () => {
    const found: ParagraphNode[] = [];
    doc.root.children().forEach((node) => {
      if (node.is(Paragraph)) found.push(node);
    });
    return found;
  };
  /** The text of every paragraph, in document order. */
  const texts = () => paragraphs().map((node) => node.state.t.get());
  /** The paragraph whose text is `text`. */
  const find = (text: string) => {
    const found = paragraphs().find((node) => node.state.t.get() === text);
    if (!found)
      throw new Error(`no paragraph "${text}" in ${JSON.stringify(texts())}`);
    return found;
  };
  return { ...attach(doc, session), texts, find };
}

/** Two replicas of the paragraphs `texts`. */
export function textPair(texts: string[]) {
  const doc = new Doc({
    type: "root",
    extensions: [{ nodes: [Paragraph] }],
    crdt: labelsEngine(),
    nodeIdGenerator: sessionIds("base"),
  });
  for (const text of texts) {
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, text);
  }
  doc.forceCommit();
  const json = doc.toJSON();
  return { a: createTextPeer("A", json), b: createTextPeer("B", json) };
}

/** What each replica did goes to the other, `a`'s first or last. */
export function exchange(a: Replica, b: Replica, aFirst = true) {
  a.doc.forceCommit();
  b.doc.forceCommit();
  const fromA = take(a);
  const fromB = take(b);
  if (aFirst) deliver(b, fromA);
  deliver(a, fromB);
  if (!aFirst) deliver(b, fromA);
}

/** Each paragraph's text and format, by id. */
function spansById(doc: Doc) {
  const spans = new Map<string, string>();
  doc.root.children().forEach((node) => {
    if (node.is(Paragraph))
      spans.set(node.id, JSON.stringify(node.state.t.spans()));
  });
  return spans;
}

/**
 * Collects, from now on, every paragraph whose text or format a remote change
 * altered without listing it in `diff.updated` or `diff.inserted`, as
 * `before->after` spans.
 */
export function unreportedTextChanges(replica: Replica) {
  const missed: string[] = [];
  let before = spansById(replica.doc);
  replica.doc.onChange(({ flags, diff }) => {
    const after = spansById(replica.doc);
    if (flags.skipUndo) {
      for (const [id, spans] of after) {
        const previous = before.get(id);
        if (previous === undefined || previous === spans) continue;
        if (!diff.updated.has(id) && !diff.inserted.has(id))
          missed.push(`${previous}->${spans}`);
      }
    }
    before = after;
  });
  return missed;
}
