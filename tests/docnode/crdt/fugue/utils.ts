import {
  Doc,
  defineNode,
  string,
  type DocNode,
  type JsonDoc,
  type JsonTree,
  type Operations,
} from "@docukit/docnode";
import { labelsEngine } from "@docukit/docnode/crdt";

export const ROOT_ID = "01jz0000000000000000000000";

export const Paragraph = defineNode({ type: "p", state: { t: string("") } });

export type Replica = ReturnType<typeof replica>;

/**
 * A replica named `name`, new or loaded from `json`, with an optional
 * normalize listener.
 */
export function replica(
  name: string,
  json?: JsonDoc | JsonTree,
  normalize?: (doc: Doc) => void,
) {
  let clock = 0;
  const register = (doc: Doc) => doc.onNormalize(() => normalize?.(doc));
  const config = {
    type: "root",
    extensions: [{ nodes: [Paragraph], register }],
    undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
    crdt: labelsEngine(),
    nodeIdGenerator: {
      generate: () => `${name}.${clock++}`,
      validate: () => true,
    },
  };
  const doc = json
    ? Doc.fromJSON({ ...config, id: ROOT_ID }, json)
    : new Doc({ ...config, id: ROOT_ID });
  doc.forceCommit();
  const outbox: Operations[] = [];
  doc.onChange((event) => {
    if (!event.flags.skipUndo) outbox.push(structuredClone(event.operations));
  });
  const write = (text: string, place: (node: DocNode) => void) => {
    const node = doc.createNode(Paragraph);
    node.state.t.set(text);
    place(node);
    doc.forceCommit();
    return node;
  };
  return {
    doc,
    /** A paragraph as the last child of `parent` (the root by default). */
    append: (text: string, parent: DocNode = doc.root) =>
      write(text, (node) => parent.append(node)),
    /** A paragraph right before `next`. */
    before: (next: DocNode, text: string) =>
      write(text, (node) => next.insertBefore(node)),
    get: (id: string) => doc.getNodeById(id)!,
    take: () => outbox.splice(0),
    receive: (batches: Operations[]) => {
      for (const batch of batches) {
        doc.applyOperations(structuredClone(batch), { skipUndo: true });
        doc.forceCommit();
      }
    },
    stored: () => structuredClone(doc.toJSON()),
  };
}

/** The texts of the children of `node` (the root by default), in order. */
export function texts(replica: Replica, node: DocNode = replica.doc.root) {
  const out: string[] = [];
  node.children().forEach((child) => {
    out.push(child.is(Paragraph) ? child.state.t.get() : child.type);
  });
  return out.join(" ");
}

/** Replicas loaded from one stored document, as peers that start together. */
export function peers(
  names: string[],
  json: JsonDoc,
  normalize?: (doc: Doc) => void,
) {
  return names.map((name) => replica(name, json, normalize));
}
