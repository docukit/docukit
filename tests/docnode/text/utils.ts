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
 * receives in order and keeps them. A replica is a document that applied the
 * batches the server kept so far.
 */
export function orderedServer(setup: (doc: Doc) => void) {
  const server = textDoc();
  const log: Operations[] = [];
  server.forceCommit();
  log.push(...batchesOf(server, () => setup(server)));
  const replica = () => {
    const doc = textDoc({ id: server.root.id });
    for (const batch of log) doc.applyOperations(batch);
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
