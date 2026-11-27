import {
  Doc,
  type DocConfig,
  type DocNode,
  type Operations,
  boolean,
  defineNode,
  string,
  text,
} from "@docukit/docnode";

/** A paragraph: a text and a flag. */
export const Paragraph = defineNode({
  type: "p",
  state: { body: text(), bold: boolean(false), title: string("") },
});

export const config: DocConfig = {
  type: "root",
  extensions: [{ nodes: [Paragraph] }],
};

/** An empty document of paragraphs. */
export const textDoc = (options?: Partial<DocConfig>) =>
  new Doc({ ...config, ...options });

/** A paragraph with `value`, appended to the root of `doc`. */
export function paragraph(doc: Doc, value = "") {
  const node = doc.createNode(Paragraph);
  node.state.body.insert(0, value);
  doc.root.append(node);
  return node;
}

/**
 * A document with undo (steps merged within `mergeInterval`) and one empty
 * paragraph, committed.
 */
export function docWithParagraph(mergeInterval = 0) {
  const doc = textDoc({ undoManager: { maxUndoSteps: 100, mergeInterval } });
  const node = paragraph(doc);
  doc.forceCommit();
  return { doc, node, body: node.state.body };
}

/** The batches `doc` writes while `edit` runs, one per commit. */
export function batchesOf(doc: Doc, edit: () => void) {
  doc.forceCommit();
  const batches: Operations[] = [];
  const stop = doc.onChange(({ operations }) => batches.push(operations));
  edit();
  doc.forceCommit();
  stop();
  return batches;
}

/** The one batch `doc` writes while `edit` runs. */
export function batchOf(doc: Doc, edit: () => void) {
  const batches = batchesOf(doc, edit);
  if (batches.length !== 1) throw new Error(`${batches.length} batches`);
  return batches[0]!;
}

/** The texts of the root's children. */
export function bodies(doc: Doc) {
  const texts: string[] = [];
  doc.root.children().forEach((node) => {
    if (node.is(Paragraph)) texts.push(node.state.body.get());
  });
  return texts;
}

/** The first paragraph of `doc`. */
export const first = (doc: Doc) => doc.root.first as DocNode<typeof Paragraph>;

/**
 * A server that orders batches, as DocSync's: it applies each batch it
 * receives in order and keeps them. A replica is a document loaded from the
 * server's document as it is now, as DocSync loads a snapshot.
 */
export function orderedServer(setup: (doc: Doc) => void) {
  const server = textDoc();
  const log: Operations[] = [];
  server.forceCommit();
  log.push(...batchesOf(server, () => setup(server)));
  const replica = (options?: Partial<DocConfig>) => {
    const doc = Doc.fromJSON({ ...config, ...options }, server.toJSON());
    doc.forceCommit();
    return doc;
  };
  return {
    server,
    log,
    replica,
    /** The batches of `edit` on `doc`, not sent yet. */
    edit: (doc: Doc, edit: (doc: Doc) => void) =>
      batchesOf(doc, () => edit(doc)),
    /** The server applies `batches` and keeps them. */
    send: (batches: Operations[]) => {
      for (const batch of batches) server.applyOperations(batch);
      server.forceCommit();
      log.push(...batches);
    },
    /**
     * A replica whose pending `batches` are applied over what the server has
     * now: how DocSync rebases them (`reconcileSyncResponse`).
     */
    rebase: (batches: Operations[]) => {
      const doc = replica();
      for (const batch of batches) doc.applyOperations(batch);
      doc.forceCommit();
      return doc;
    },
  };
}

type Edit = (
  body: DocNode<typeof Paragraph>["state"]["body"],
  doc: Doc,
) => void;

/**
 * Two replicas edit the first paragraph at once from what `setup` made. The
 * server gets `a` first, then `b`. Replica A applies `b` over its state, and
 * replica B rebases its pending `b` over the server's state. Returns the
 * texts of the server and both replicas.
 */
export function concurrent(setup: (doc: Doc) => void, a: Edit, b: Edit) {
  const { server, replica, edit, send, rebase } = orderedServer(setup);
  const [docA, docB] = [replica(), replica()];
  const batchesA = edit(docA, (doc) => a(first(doc).state.body, doc));
  const batchesB = edit(docB, (doc) => b(first(doc).state.body, doc));
  send(batchesA);
  send(batchesB);
  for (const batch of batchesB) docA.applyOperations(batch);
  docA.forceCommit();
  const rebased = rebase(batchesB);
  return [server, docA, rebased].map(bodies);
}
