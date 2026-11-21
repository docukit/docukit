import {
  Doc,
  type Diff,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import {
  createLexicalDocNodeConfig,
  syncLexicalWithDoc,
  updatePresence,
  type Presence,
  type PresenceSelection,
} from "@docukit/docnode-lexical";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  createEditor,
  DecoratorNode,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { onTestFinished } from "vitest";

/** The root state of a new document: it merges text letter by letter. */
export const ROOT_STATE = { "~textConflicts": JSON.stringify("letter") };

/** An empty document. */
export const createLexicalDoc = ({
  enableUndoManager = true,
  mergeInterval = 0,
}: { enableUndoManager?: boolean; mergeInterval?: number } = {}): Doc => {
  const doc = Doc.fromJSON(
    createLexicalDocNodeConfig({
      type: "root",
      undoManager: { maxUndoSteps: enableUndoManager ? 100 : 0, mergeInterval },
    }),
    ["01kc52hq510g6y44jhq0wqrjb3", "root", ROOT_STATE],
  );
  doc.forceCommit();
  return doc;
};

/** A block that is not text, like an image. */
export class ImageNode extends DecoratorNode<undefined> {
  static override getType() {
    return "test-image";
  }
  static override clone(node: ImageNode) {
    return new ImageNode(node.__key);
  }
  static override importJSON() {
    return new ImageNode();
  }
  override createDOM() {
    const image = document.createElement("div");
    image.style.height = "40px";
    return image;
  }
  override updateDOM() {
    return false;
  }
  override decorate() {
    return undefined;
  }
}

const createThrowingEditor = (nodes: Klass<LexicalNode>[] = []) =>
  createEditor({
    namespace: "test",
    nodes,
    onError: (error) => {
      throw error;
    },
  });

/** An editor bound to a new document that starts with a paragraph per text. */
export function createSyncedEditor(paragraphs: string[]) {
  const doc = createLexicalDoc();
  const editor = createThrowingEditor();
  syncLexicalWithDoc(editor, doc);
  editor.update(
    () => {
      $getRoot().append(
        ...paragraphs.map((text) =>
          $createParagraphNode().append($createTextNode(text)),
        ),
      );
    },
    { discrete: true },
  );
  return {
    doc,
    editor,
    /** Runs a local editor update and returns the diff it caused in DocNode. */
    update: (change: () => void) => {
      let diff: Diff | undefined;
      const stop = doc.onChange((event) => {
        diff = event.diff;
      });
      editor.update(change, { discrete: true });
      stop();
      return diff;
    },
  };
}

/** The text of each paragraph of `doc`, as a new editor loads them. */
export function loadedTexts(doc: Doc): string[] {
  const editor = createThrowingEditor();
  const config = createLexicalDocNodeConfig({ type: "root" });
  syncLexicalWithDoc(
    editor,
    Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON()),
  );
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((child) => child.getTextContent()),
  );
}

// ----- peers that sync through a server, as DocSync does -------------------

/** Ids `<session>.<clock>`, so text ties break the same way in every run. */
const lexicalConfig = (session: string) =>
  createLexicalDocNodeConfig({
    type: "root",
    undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
    nodeIdGenerator: (() => {
      let clock = 0;
      return { generate: () => `${session}.${clock++}`, validate: () => true };
    })(),
  });

const editorTexts = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((child) => child.getTextContent()),
  );

/** The id of the documents of `createPeers`. */
const DOC_ID = "01kc52hq510g6y44jhq0wqrjb3";

/** A document with a paragraph per text, as an editor would have stored it. */
function paragraphsJson(paragraphs: string[]): JsonDoc {
  const doc = Doc.fromJSON(lexicalConfig("base"), [DOC_ID, "root", ROOT_STATE]);
  doc.forceCommit();
  const editor = createThrowingEditor();
  syncLexicalWithDoc(editor, doc);
  editor.update(
    () => {
      $getRoot().append(
        ...paragraphs.map((text) =>
          $createParagraphNode().append($createTextNode(text)),
        ),
      );
    },
    { discrete: true },
  );
  return doc.toJSON();
}

/**
 * An editor shown in the page, for its remote cursors. Its selection is sent
 * as presence while it has the focus.
 */
function mountedEditor(editor: LexicalEditor) {
  const frame = document.createElement("div");
  const root = document.createElement("div");
  root.contentEditable = "true";
  frame.append(root);
  document.body.append(frame);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    frame.remove();
  });
  return root;
}

/** Where a remote caret is shown: each block's text, `|` at the caret. */
export function shownCaret(root: HTMLElement, name: string) {
  const label = [...(root.parentElement?.querySelectorAll("span") ?? [])].find(
    (span) => span.childElementCount === 0 && span.textContent === name,
  );
  const blocks = [...root.children];
  const texts = blocks.map((block) => block.textContent);
  const caret = label?.parentElement?.getBoundingClientRect();
  if (!caret) return texts;
  const range = document.caretRangeFromPoint(
    caret.left + caret.width / 2,
    caret.top + caret.height / 2,
  )!;
  // Right before a block that is not text: the root, at that block.
  const block =
    range.startContainer === root
      ? range.startOffset
      : blocks.findIndex((each) => each.contains(range.startContainer));
  const before = document.createRange();
  before.setStart(blocks[block]!, 0);
  if (range.startContainer !== root)
    before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  const text = texts[block]!;
  texts[block] = `${text.slice(0, offset)}|${text.slice(offset)}`;
  return texts;
}

/** What a peer shows of another one's presence. */
type RemotePeer = {
  readonly session: string;
  readonly presence: PresenceSelection | undefined;
};

function createPeer(json: JsonDoc, session: string, mounted: boolean) {
  // Each document gets its own session, as with DocNode's default ids.
  let generation = 0;
  const nextConfig = () => ({
    ...lexicalConfig(`${session}-${generation++}`),
    id: DOC_ID,
  });
  const editor = createThrowingEditor(mounted ? [ImageNode] : undefined);
  const root = mounted ? mountedEditor(editor) : undefined;
  /** The presence this peer sent last. */
  let presence: PresenceSelection | undefined;
  const options = mounted
    ? {
        setPresence: (selection: PresenceSelection | undefined) => {
          presence = selection;
        },
        user: { name: session, color: "#2563eb" },
      }
    : undefined;
  let receiving = false;
  const outbox: Operations[] = [];
  let doc = Doc.fromJSON(nextConfig(), json);
  let unbind: (() => void) | undefined;
  const bind = () => {
    doc.forceCommit();
    unbind = syncLexicalWithDoc(editor, doc, options);
    doc.onChange(({ operations }) => {
      if (!receiving) outbox.push(operations);
    });
  };
  bind();
  return {
    get doc() {
      return doc;
    },
    outbox,
    received: 0,
    update(change: () => void) {
      editor.update(change, { discrete: true });
    },
    undo() {
      doc.undoManager.undo();
      doc.forceCommit();
    },
    redo() {
      doc.undoManager.redo();
      doc.forceCommit();
    },
    apply(operations: Operations) {
      receiving = true;
      doc.applyOperations(operations, { skipUndo: true });
      doc.forceCommit();
      receiving = false;
    },
    /**
     * Replaces the document with the server's, as DocSync does once the server
     * has every change of this peer, and binds the editor to it.
     */
    replaceDoc(serverJson: JsonDoc) {
      const history = doc.undoManager.exportHistory();
      unbind?.();
      doc.dispose();
      doc = Doc.fromJSON(nextConfig(), serverJson);
      doc.undoManager.importHistory(history);
      bind();
    },
    /** What the editor shows, paragraph by paragraph. */
    texts: () => editorTexts(editor),
    /** `texts`, with `|` where the local caret is. */
    textsWithCaret: () => editor.getEditorState().read($textsWithCaret),
    get presence() {
      return presence;
    },
    /** Puts the caret at `offset` of a paragraph, focusing a shown editor. */
    select(index: number, offset: number) {
      root?.focus();
      editor.update(() => $selectAt(index, offset), { discrete: true });
    },
    /** Shows the cursors of these peers' last presence. */
    show(...others: RemotePeer[]) {
      const remote: Presence = {};
      for (const other of others)
        if (other.presence)
          remote[other.session] = {
            ...other.presence,
            name: other.session,
            color: "#16a34a",
          };
      updatePresence(editor, remote);
    },
    /** Where this editor shows the caret of `other`: see `shownCaret`. */
    caretOf: (other: RemotePeer) => shownCaret(root!, other.session),
    session,
  };
}
export type Peer = ReturnType<typeof createPeer>;

/**
 * Peers that start from the same paragraphs. Each one applies its own changes at once and the others' in the
 * order the server got them. `sync` does not reconcile like DocSync: a real
 * client rebuilds its document from the server's state and then reapplies its
 * pending changes. Without it, peers can end with different trees, because
 * DocNode tree operations are applied in a different order on each peer, and
 * only the text state is expected to converge. `syncAsDocSync` does.
 */
export function createPeers(
  paragraphs: string[],
  count = 2,
  /** Editors shown in the page, which send and show presence. */
  mounted = false,
) {
  const json = paragraphsJson(paragraphs);
  const server = Doc.fromJSON({ ...lexicalConfig("server"), id: DOC_ID }, json);
  server.forceCommit();
  const log: { from: Peer; operations: Operations }[] = [];
  const peers = Array.from({ length: count }, (_, index) =>
    createPeer(json, `p${index}`, mounted),
  );
  const send = (peer: Peer) => {
    for (const operations of peer.outbox.splice(0)) {
      server.applyOperations(operations);
      server.forceCommit();
      log.push({ from: peer, operations });
    }
  };
  const receive = (peer: Peer) => {
    for (; peer.received < log.length; peer.received++) {
      const entry = log[peer.received]!;
      if (entry.from !== peer) peer.apply(entry.operations);
    }
  };
  return {
    server,
    peers,
    send,
    receive,
    /** Every peer sends what it has, then receives what it lacks. */
    sync: () => {
      peers.forEach(send);
      peers.forEach(receive);
    },
    /** Every peer sends what it has, then takes the server's document. */
    syncAsDocSync: () => {
      peers.forEach(send);
      const serverJson = server.toJSON();
      for (const peer of peers) {
        peer.received = log.length;
        peer.replaceDoc(serverJson);
      }
    },
  };
}

/** Two peers whose editors are in the page, to show each other's cursors. */
export const createMountedPeers = (paragraphs: string[]) =>
  createTwoPeers(paragraphs, true);

/** `createPeers` with two peers, `a` and `b`. */
export function createTwoPeers(paragraphs: string[], mounted = false) {
  const { peers, sync } = createPeers(paragraphs, 2, mounted);
  const [a, b] = peers;
  if (!a || !b) throw new Error("Expected two peers");
  return { a, b, sync };
}

/** Selects `offset` of the `index`-th paragraph's text, clamped to its end. */
export function $selectAt(index: number, offset: number) {
  const paragraph = $getRoot().getChildAtIndex<ElementNode>(index)!;
  let rest = offset;
  for (const child of paragraph.getChildren()) {
    const size = child.getTextContentSize();
    if ($isTextNode(child) && rest <= size) {
      child.select(rest, rest);
      return;
    }
    rest -= size;
  }
  paragraph.selectEnd();
}

/** The text of each paragraph, `|` at the caret (the selection's focus). */
export function $textsWithCaret() {
  const paragraphs = $getRoot().getChildren();
  const texts = paragraphs.map((paragraph) => paragraph.getTextContent());
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return texts;
  const { focus } = selection;
  const node = focus.getNode();
  const index = paragraphs.findIndex(
    (paragraph) => paragraph.isParentOf(node) || paragraph.is(node),
  );
  const paragraph = paragraphs[index];
  const children = $isElementNode(paragraph) ? paragraph.getChildren() : [];
  const at =
    focus.type === "text"
      ? children.findIndex((child) => child.is(node))
      : focus.offset;
  let offset = focus.type === "text" ? focus.offset : 0;
  for (const child of children.slice(0, at))
    offset += child.getTextContentSize();
  const text = texts[index]!;
  texts[index] = `${text.slice(0, offset)}|${text.slice(offset)}`;
  return texts;
}

export const $typeAt = (index: number, offset: number, text: string) => {
  $selectAt(index, offset);
  $getSelection()!.insertText(text);
};

export const $enterAt = (index: number, offset: number) => {
  $selectAt(index, offset);
  const selection = $getSelection();
  if ($isRangeSelection(selection)) selection.insertParagraph();
};

/** Selects the letter after `offset` and deletes it, if the first text has it. */
export const $deleteAt = (index: number, offset: number) => {
  const text = $getRoot().getChildAtIndex<ElementNode>(index)!.getFirstChild();
  if (!$isTextNode(text) || text.getTextContentSize() <= offset) return;
  text.select(offset, offset + 1).removeText();
};

/** Backspace at the start of the `index`-th paragraph. */
export const $joinWithPrevious = (index: number) => {
  const paragraph = $getRoot().getChildAtIndex<ElementNode>(index)!;
  const previous = paragraph.getPreviousSibling<ElementNode>()!;
  previous.selectEnd();
  previous.append(...paragraph.getChildren());
  paragraph.remove();
};

/** New paragraphs with these texts, before the `index`-th one. */
export const $insertParagraphsAt = (index: number, texts: string[]) => {
  const before = $getRoot().getChildAtIndex(index)!;
  for (const text of texts)
    before.insertBefore($createParagraphNode().append($createTextNode(text)));
};
