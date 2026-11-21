import {
  Doc,
  type DocNode,
  type Json,
  type Operations,
} from "@docukit/docnode";
import { labelsEngine, type LabelsOptions } from "@docukit/docnode/crdt";
import { expect } from "vitest";

import { Text, TextExtension } from "../../utils.js";

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
  const stored = doc.toJSON()[9];
  const [, , , extras, deleted, limbo, aliases, rootStamps, pending] = isList(
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
