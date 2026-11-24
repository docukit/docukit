import { Doc, rebase, type JsonDoc, type Operations } from "@docukit/docnode";
import { labelsEngine } from "@docukit/docnode/crdt";
import {
  createLexicalDocNodeConfig,
  syncLexicalWithDoc,
} from "@docukit/docnode-lexical";
import {
  $insertList,
  $removeList,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import { $toggleLink, LinkNode } from "@lexical/link";
import {
  $createHeadingNode,
  $isHeadingNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  $setSelection,
  createEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from "lexical";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";

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
  };
}
type Rng = ReturnType<typeof randomizer>;

const config = (session: string) => {
  let clock = 0;
  return createLexicalDocNodeConfig({
    type: "root",
    undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
    // `FUZZ_ENGINE=labels`: with the labels CRDT engine instead of Base.
    ...(process.env.FUZZ_ENGINE === "labels" ? { crdt: labelsEngine() } : {}),
    nodeIdGenerator: {
      generate: () => `${session}.${clock++}`,
      validate: () => true,
    },
  });
};

export const createFuzzEditor = () =>
  createEditor({
    namespace: "fuzz",
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode],
    onError: (error) => {
      throw error;
    },
  });

/** The editor's whole tree, as Lexical writes it. */
export const viewOf = (editor: LexicalEditor) =>
  JSON.stringify(editor.getEditorState().toJSON());

/** What a new editor shows for a stored document. */
export function loadedView(json: JsonDoc): string {
  const doc = Doc.fromJSON({ ...config("view"), id: ROOT_ID }, json);
  doc.forceCommit();
  const editor = createFuzzEditor();
  syncLexicalWithDoc(editor, doc);
  return viewOf(editor);
}

/**
 * Base relies on the server's order (see `BaseText`): a peer whose own edits
 * are still on their way takes the server's document instead, as DocSync
 * does. The CRDT engine applies the server's batches on top of them.
 */
const REPLACES = process.env.FUZZ_ENGINE !== "labels";

function createPeer(json: JsonDoc, session: string) {
  const editor = createFuzzEditor();
  const outbox: Operations[] = [];
  let receiving = false;
  let unbind: () => void = () => undefined;
  let replaced = 0;
  const bind = (doc: Doc) => {
    unbind();
    doc.forceCommit();
    unbind = syncLexicalWithDoc(editor, doc);
    doc.onChange(({ operations }) => {
      if (!receiving) outbox.push(operations);
    });
    return doc;
  };
  const peer = {
    doc: bind(Doc.fromJSON({ ...config(session), id: ROOT_ID }, json)),
    editor,
    outbox,
    received: 0,
    session,
    update(change: () => void) {
      editor.update(change, { discrete: true });
      peer.doc.forceCommit();
    },
    apply(operations: Operations) {
      receiving = true;
      peer.doc.applyOperations(operations, { skipUndo: true });
      peer.doc.forceCommit();
      receiving = false;
    },
    /**
     * DocSync's `replaceDoc`: the server's document, then what this peer did
     * that the server has not seen yet, and the undo history. A new
     * document has a new session, as with the default ids.
     */
    replace(stored: JsonDoc) {
      const old = peer.doc;
      const next = Doc.fromJSON(
        { ...config(`${session}r${++replaced}`), id: ROOT_ID },
        stored,
      );
      next.forceCommit();
      // From now on it rebases in place, with the editor bound (`rebase`).
      rebase(next);
      receiving = true;
      for (const operations of outbox)
        next.applyOperations(operations, { skipUndo: true });
      next.forceCommit();
      receiving = false;
      next.undoManager.importHistory(old.undoManager.exportHistory());
      peer.doc = bind(next);
      old.dispose();
    },
    /**
     * DocSync's rebase in place, once the peer was replaced: what the server
     * ordered since it last synced, then what it did that the server has not
     * seen yet. False when it was never replaced.
     */
    rebase(batches: Operations[]) {
      receiving = true;
      const rebased = rebase(peer.doc, batches);
      if (rebased)
        for (const operations of outbox)
          peer.doc.applyOperations(operations, { skipUndo: true });
      peer.doc.forceCommit();
      receiving = false;
      return rebased;
    },
  };
  return peer;
}
type Peer = ReturnType<typeof createPeer>;

/** The text blocks of the editor, in order. */
function $blocks(): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (node: LexicalNode) => {
    if (!$isElementNode(node)) return;
    const children = node.getChildren();
    const inline = children.every(
      (child) => !$isElementNode(child) || child.isInline(),
    );
    if (!$isRootOrShadowRoot(node) && !node.isInline() && inline)
      out.push(node);
    else children.forEach(walk);
  };
  walk($getRoot());
  return out;
}

/** The text nodes of a block with where each starts in its text. */
function $texts(block: ElementNode): [TextNode, number][] {
  const out: [TextNode, number][] = [];
  let offset = 0;
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      out.push([node, offset]);
      offset += node.getTextContentSize();
    } else if ($isElementNode(node)) node.getChildren().forEach(walk);
    else offset += node.getTextContentSize();
  };
  block.getChildren().forEach(walk);
  return out;
}

/** Selects `[from, to)` of a block's text when text nodes hold both ends. */
function $select(block: ElementNode, from: number, to = from): boolean {
  const texts = $texts(block);
  const point = (offset: number) => {
    for (const [node, start] of texts)
      if (offset >= start && offset <= start + node.getTextContentSize())
        return [node.getKey(), offset - start] as const;
    return undefined;
  };
  const a = point(from);
  const b = point(to);
  const selection = $createRangeSelection();
  if (!a || !b) {
    if (from !== to) return false;
    block.selectEnd();
    return true;
  }
  selection.anchor.set(a[0], a[1], "text");
  selection.focus.set(b[0], b[1], "text");
  // Typing takes the format of the text it is typed in, as in an editor.
  const node = $getNodeByKey(a[0]);
  if ($isTextNode(node)) selection.setFormat(node.getFormat());
  $setSelection(selection);
  return true;
}

const $removeSelected = () => {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) selection.removeText();
};

const word = (rng: Rng) =>
  Array.from({ length: 1 + rng.int(4) }, () => "abcdefgh  "[rng.int(10)]!).join(
    "",
  );

/** One random user edit on a peer. */
function randomEdit(peer: Peer, rng: Rng) {
  const roll = rng.next();
  if (roll < 0.06) {
    peer.editor.dispatchCommand(
      rng.next() < 0.7 ? UNDO_COMMAND : REDO_COMMAND,
      undefined,
    );
    peer.doc.forceCommit();
    return;
  }
  peer.update(() => {
    const blocks = $blocks();
    if (blocks.length === 0) {
      $getRoot().append($createParagraphNode());
      return;
    }
    const block = rng.pick(blocks);
    const size = block.getTextContentSize();
    const at = rng.int(size + 1);
    if (roll < 0.4) {
      if ($select(block, at)) $getSelection()?.insertText(word(rng));
    } else if (roll < 0.5 && size > 0) {
      const from = rng.int(size);
      const to = Math.min(size, from + 1 + rng.int(4));
      if ($select(block, from, to)) $removeSelected();
    } else if (roll < 0.6) {
      if ($select(block, at)) {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertParagraph();
      }
    } else if (roll < 0.68) {
      if (blocks.indexOf(block) > 0 && $select(block, 0)) {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.deleteCharacter(true);
      }
    } else if (roll < 0.78 && size > 1) {
      const from = rng.int(size - 1);
      const to = from + 1 + rng.int(size - from - 1);
      if ($select(block, from, to)) {
        const selection = $getSelection();
        if ($isRangeSelection(selection))
          selection.formatText(rng.next() < 0.6 ? "bold" : "italic");
      }
    } else if (roll < 0.84) {
      const top = block.getTopLevelElement();
      if (top?.is(block)) {
        const replacement = $isHeadingNode(block)
          ? $createParagraphNode()
          : $createHeadingNode(rng.pick(["h1", "h2"] as const));
        block.replace(replacement, true);
      }
    } else if (roll < 0.9) {
      $select(block, at);
      const inList = block.getParent() instanceof ListNode;
      if (inList) $removeList();
      else if (!$isHeadingNode(block))
        $insertList(rng.pick(["bullet", "number"] as const));
    } else if (roll < 0.94 && size > 1) {
      const from = rng.int(size - 1);
      if ($select(block, from, from + 1 + rng.int(size - from - 1)))
        $toggleLink(rng.next() < 0.7 ? `https://${rng.int(3)}.x` : null);
    } else {
      const tops = $getRoot().getChildren();
      if (tops.length > 1) {
        const node = rng.pick(tops);
        const target = rng.pick(tops);
        if (!node.is(target))
          if (rng.next() < 0.5) target.insertBefore(node);
          else target.insertAfter(node);
      }
    }
  });
}

export type FuzzStats = {
  seeds: number;
  /** Seeds whose documents differ between replicas. */
  docDivergent: number[];
  /** Seeds whose editors show different trees. */
  viewDivergent: number[];
  /** Seeds where an edit threw. */
  errors: number[];
  moveProbes: number;
  /** Words typed in a paragraph moved at the same time, gone. */
  moveLost: number;
  /** ... still there, but in another paragraph than the moved one. */
  moveDisplaced: number;
  boldProbes: number;
  /** Words typed inside a range made bold at the same time, not bold. */
  boldMissed: number;
  joinProbes: number;
  /** A heading set on a line joined into the one before at the same time: kept. */
  joinHeadingKept: number;
  undoProbes: number;
  /** Two peers deleted a word and both undid it: the word shows twice. */
  undoDuplicated: number;
};

/**
 * Peers that sync through a server, as DocSync does: each applies its own
 * edits at once and everyone else's in the server's order (see `REPLACES`).
 */
export function createCluster(count: number, texts: string[]) {
  const seed = Doc.fromJSON(config("seed"), [
    ROOT_ID,
    "root",
    { "~textConflicts": JSON.stringify("letter") },
  ]);
  seed.forceCommit();
  const editor = createFuzzEditor();
  syncLexicalWithDoc(editor, seed);
  editor.update(
    () => {
      $getRoot().append(
        ...texts.map((text) => {
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode(text));
          return paragraph;
        }),
      );
    },
    { discrete: true },
  );
  seed.forceCommit();
  const json = seed.toJSON();
  const server = Doc.fromJSON({ ...config("server"), id: seed.root.id }, json);
  server.forceCommit();
  const peers = Array.from({ length: count }, (_, i) =>
    createPeer(json, `p${i}`),
  );
  const log: { from: Peer; operations: Operations }[] = [];
  const send = (peer: Peer) => {
    for (const operations of peer.outbox.splice(0)) {
      server.applyOperations(operations, { skipUndo: true });
      server.forceCommit();
      log.push({ from: peer, operations });
    }
  };
  const receive = (peer: Peer) => {
    const fresh = log.slice(peer.received);
    if (
      fresh.length > 0 &&
      peer.rebase(fresh.map((entry) => entry.operations))
    ) {
      peer.received = log.length;
      return;
    }
    if (
      REPLACES &&
      fresh.some((entry) => entry.from !== peer) &&
      (peer.outbox.length > 0 || fresh.some((entry) => entry.from === peer))
    ) {
      peer.received = log.length;
      peer.replace(server.toJSON());
      return;
    }
    for (; peer.received < log.length; peer.received++) {
      const entry = log[peer.received]!;
      if (entry.from !== peer) peer.apply(entry.operations);
    }
  };
  const sync = () => {
    peers.forEach(send);
    peers.forEach(receive);
  };
  return { peers, server, send, receive, sync };
}

const textOf = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

/** Whether `token` shows bold in the editor (every letter of it). */
const isBold = (editor: LexicalEditor, token: string) =>
  editor.getEditorState().read(() => {
    for (const block of $blocks()) {
      const texts = $texts(block);
      const plain = block.getTextContent();
      const at = plain.indexOf(token);
      if (at === -1) continue;
      for (let i = at; i < at + token.length; i++) {
        const holder = texts.find(
          ([node, start]) =>
            i >= start && i < start + node.getTextContentSize(),
        );
        if (!holder?.[0].hasFormat("bold")) return false;
      }
      return true;
    }
    return false;
  });

/**
 * Random concurrent histories on 3 peers, with probes of what users meant
 * in the middle of them.
 */
export function runLexicalFuzz(seeds: number[], steps = 30): FuzzStats {
  const stats: FuzzStats = {
    seeds: 0,
    docDivergent: [],
    viewDivergent: [],
    errors: [],
    moveProbes: 0,
    moveLost: 0,
    moveDisplaced: 0,
    boldProbes: 0,
    boldMissed: 0,
    joinProbes: 0,
    joinHeadingKept: 0,
    undoProbes: 0,
    undoDuplicated: 0,
  };
  for (const seed of seeds) {
    stats.seeds++;
    const rng = randomizer(seed);
    try {
      const cluster = createCluster(3, [
        "Hello world",
        "The quick brown fox",
        "jumps over",
      ]);
      const { peers } = cluster;
      let token = 0;
      for (let step = 0; step < steps; step++) {
        const roll = rng.next();
        if (roll < 0.06) probeMove(cluster, rng, stats, `q${seed}x${token++}q`);
        else if (roll < 0.12)
          probeBold(cluster, rng, stats, `k${seed}x${token++}k`);
        else if (roll < 0.15) probeJoin(cluster, rng, stats);
        else if (roll < 0.18)
          probeUndo(cluster, rng, stats, `u${seed}x${token++}u`);
        else randomEdit(rng.pick(peers), rng);
        if (rng.next() < 0.3) cluster.send(rng.pick(peers));
        if (rng.next() < 0.3) cluster.receive(rng.pick(peers));
      }
      cluster.sync();
      const docs = new Set(
        [...peers.map((peer) => peer.doc), cluster.server].map((doc) =>
          JSON.stringify(doc.toJSON()),
        ),
      );
      if (docs.size > 1) stats.docDivergent.push(seed);
      const views = new Set([
        ...peers.map((peer) => viewOf(peer.editor)),
        loadedView(cluster.server.toJSON()),
      ]);
      if (views.size > 1) {
        stats.viewDivergent.push(seed);
        if (process.env.FUZZ_VERBOSE)
          for (const view of views) console.error(seed, view);
      }
    } catch (error) {
      stats.errors.push(seed);
      if (process.env.FUZZ_VERBOSE) console.error(seed, error);
    }
  }
  return stats;
}

type Cluster = ReturnType<typeof createCluster>;

/** Peer 0 moves a top-level paragraph while peer 1 types a word in it. */
function probeMove(
  cluster: Cluster,
  rng: Rng,
  stats: FuzzStats,
  token: string,
) {
  cluster.sync();
  const [a, b] = cluster.peers as [Peer, Peer];
  const count = a.editor
    .getEditorState()
    .read(() => $getRoot().getChildrenSize());
  if (count < 2) return;
  const from = rng.int(count);
  let to = rng.int(count);
  if (to === from) to = (to + 1) % count;
  let typed = false;
  let original = "";
  b.update(() => {
    const node = $getRoot().getChildAtIndex(from);
    if (!$isElementNode(node) || !$blocks().includes(node)) return;
    original = node.getTextContent();
    if ($select(node, rng.int(node.getTextContentSize() + 1))) {
      $getSelection()?.insertText(token);
      typed = true;
    }
  });
  if (!typed) return;
  a.update(() => {
    const node = $getRoot().getChildAtIndex(from)!;
    const target = $getRoot().getChildAtIndex(to)!;
    if (to > from) target.insertAfter(node);
    else target.insertBefore(node);
  });
  cluster.sync();
  stats.moveProbes++;
  const editor = cluster.peers[2]!.editor;
  if (!textOf(editor).includes(token)) stats.moveLost++;
  else {
    const home = editor
      .getEditorState()
      .read(() =>
        $blocks().find((block) => block.getTextContent().includes(token)),
      );
    const rest = editor
      .getEditorState()
      .read(() => home?.getTextContent().replace(token, "") ?? "");
    if (rest !== original) stats.moveDisplaced++;
  }
}

/** Peer 0 makes a range bold while peer 1 types a word inside it. */
function probeBold(
  cluster: Cluster,
  rng: Rng,
  stats: FuzzStats,
  token: string,
) {
  cluster.sync();
  const [a, b] = cluster.peers as [Peer, Peer];
  // A block and a range of plain letters in it, the same on both peers.
  let index = -1;
  let from = 0;
  let to = 0;
  a.editor.getEditorState().read(() => {
    const blocks = $blocks();
    for (let tries = 0; tries < 5 && index === -1; tries++) {
      const i = rng.int(blocks.length);
      const texts = $texts(blocks[i]!);
      const plain = texts.find(
        ([node]) => node.getFormat() === 0 && node.getTextContentSize() >= 3,
      );
      if (!plain) continue;
      index = i;
      from = plain[1];
      to = plain[1] + plain[0].getTextContentSize();
    }
  });
  if (index === -1) return;
  const inside = from + 1 + rng.int(to - from - 1);
  let typed = false;
  b.update(() => {
    const block = $blocks()[index];
    if (block && $select(block, inside)) {
      $getSelection()?.insertText(token);
      typed = true;
    }
  });
  a.update(() => {
    const block = $blocks()[index];
    if (block && $select(block, from, to)) {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.formatText("bold");
    }
  });
  if (!typed) return;
  cluster.sync();
  stats.boldProbes++;
  if (!isBold(cluster.peers[2]!.editor, token)) stats.boldMissed++;
}

/** Peer 0 makes a paragraph a heading while peer 1 joins it into the previous one. */
function probeJoin(cluster: Cluster, rng: Rng, stats: FuzzStats) {
  cluster.sync();
  const [a, b] = cluster.peers as [Peer, Peer];
  const count = a.editor
    .getEditorState()
    .read(() => $getRoot().getChildrenSize());
  if (count < 2) return;
  const index = 1 + rng.int(count - 1);
  let ok = false;
  a.editor.getEditorState().read(() => {
    const node = $getRoot().getChildAtIndex(index);
    const previous = $getRoot().getChildAtIndex(index - 1);
    ok =
      $isElementNode(node) &&
      $isElementNode(previous) &&
      node.getType() === "paragraph" &&
      previous.getType() === "paragraph" &&
      node.getTextContentSize() > 0;
  });
  if (!ok) return;
  a.update(() => {
    const node = $getRoot().getChildAtIndex<ElementNode>(index)!;
    node.replace($createHeadingNode("h2"), true);
  });
  b.update(() => {
    const node = $getRoot().getChildAtIndex<ElementNode>(index)!;
    if ($select(node, 0)) {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.deleteCharacter(true);
    }
  });
  cluster.sync();
  stats.joinProbes++;
  const heading = cluster.peers[2]!.editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .some((node) => $isHeadingNode(node)),
  );
  if (heading) stats.joinHeadingKept++;
}

/** Two peers delete the same word, then both undo. */
function probeUndo(
  cluster: Cluster,
  rng: Rng,
  stats: FuzzStats,
  token: string,
) {
  cluster.sync();
  const [a, b] = cluster.peers as [Peer, Peer];
  a.update(() => {
    const blocks = $blocks();
    const block = blocks[rng.int(blocks.length)];
    if (block && $select(block, 0)) $getSelection()?.insertText(token);
  });
  cluster.sync();
  for (const peer of [a, b])
    peer.update(() => {
      for (const block of $blocks()) {
        const at = block.getTextContent().indexOf(token);
        if (at !== -1 && $select(block, at, at + token.length)) {
          $removeSelected();
          return;
        }
      }
    });
  cluster.sync();
  for (const peer of [a, b]) {
    peer.editor.dispatchCommand(UNDO_COMMAND, undefined);
    peer.doc.forceCommit();
  }
  cluster.sync();
  stats.undoProbes++;
  const text = textOf(cluster.peers[2]!.editor);
  if (text.split(token).length - 1 > 1) stats.undoDuplicated++;
}
