import { describe, expect, test } from "vitest";
import { Doc } from "@docukit/docnode";
import {
  createLexicalDocNodeConfig,
  syncLexicalWithDoc,
} from "@docukit/docnode-lexical";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
  type ElementNode,
} from "lexical";

import { jsonTree } from "../docnode/utils.js";
import { randomizer } from "../docnode/text/utils.js";
import {
  $deleteAt,
  $enterAt,
  $joinWithPrevious,
  $typeAt,
  createPeers,
  createSyncedEditor,
  loadedTexts,
  ROOT_STATE,
  type Peer,
} from "./utils.js";

const config = () => createLexicalDocNodeConfig({ type: "root" });

/** A new editor bound to a copy of `doc` loaded from its stored form. */
function loadStored(doc: Doc) {
  const copy = Doc.fromJSON({ ...config(), id: doc.root.id }, doc.toJSON());
  copy.forceCommit();
  const editor = createEditor({
    namespace: "loaded",
    onError: (error) => {
      throw error;
    },
  });
  syncLexicalWithDoc(editor, copy);
  return { copy, editor };
}

/** Whether `doc` stores each paragraph's text as one letter-by-letter value. */
const storesLetters = (doc: Doc) => {
  const [, , state, children] = jsonTree(doc);
  const paragraphs = children ?? [];
  return {
    textValue: "~t" in state,
    textNodes: paragraphs.some(([, , , inline]) => inline !== undefined),
  };
};

test("a new document records that it merges text letter by letter", () => {
  expect(jsonTree(new Doc(config()))[2]).toStrictEqual(ROOT_STATE);
});

describe("merging text letter by letter", () => {
  test("what an editor wrote loads the same, and is stored the same again", () => {
    const { doc, editor, update } = createSyncedEditor([
      "Hello world",
      "Second line",
    ]);
    update(() => {
      $typeAt(0, 5, ",");
      $enterAt(1, 6);
      $deleteAt(0, 0);
    });
    update(() => {
      $getRoot()
        .getFirstChildOrThrow<ElementNode>()
        .getAllTextNodes()[0]!
        .select(6, 11)
        .formatText("bold");
    });
    expect(storesLetters(doc)).toStrictEqual({
      textValue: true,
      textNodes: false,
    });
    const { copy, editor: loaded } = loadStored(doc);
    expect(loaded.getEditorState().toJSON()).toStrictEqual(
      editor.getEditorState().toJSON(),
    );
    expect(copy.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("Ctrl+Z and Ctrl+Y go through DocNode's history, not Lexical's", () => {
    const { doc, editor } = createSyncedEditor(["Hello"]);
    editor.update(() => $typeAt(0, 5, " world"), { discrete: true });
    expect(doc.undoManager.canUndo()).toBe(true);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(loadedTexts(doc)).toStrictEqual(["Hello"]);
    expect(doc.undoManager.canRedo()).toBe(true);
    editor.dispatchCommand(REDO_COMMAND, undefined);
    expect(loadedTexts(doc)).toStrictEqual(["Hello world"]);
  });

  test("undo and redo go back and forth through each edit", () => {
    const { doc, editor } = createSyncedEditor(["Hello", "world"]);
    const texts = [loadedTexts(doc)];
    for (const change of [
      () => $typeAt(0, 5, "!"),
      () => $enterAt(1, 2),
      () => $joinWithPrevious(1),
    ]) {
      editor.update(change, { discrete: true });
      texts.push(loadedTexts(doc));
    }
    const shows = (index: number) => {
      expect(loadedTexts(doc)).toStrictEqual(texts[index]);
      expect(
        editor.getEditorState().read(() =>
          $getRoot()
            .getChildren()
            .map((child) => child.getTextContent()),
        ),
      ).toStrictEqual(texts[index]);
    };
    for (let index = 2; index >= 0; index--) {
      doc.undoManager.undo();
      doc.forceCommit();
      shows(index);
    }
    for (let index = 1; index <= 3; index++) {
      doc.undoManager.redo();
      doc.forceCommit();
      shows(index);
    }
  });
});

describe("a document with many paragraphs", () => {
  test("is synced in time linear in its size", () => {
    const { doc, editor } = createSyncedEditor([]);
    const start = performance.now();
    editor.update(
      () => {
        for (let index = 0; index < 5000; index++)
          $getRoot().append(
            $createParagraphNode().append($createTextNode(`line ${index}`)),
          );
      },
      { discrete: true },
    );
    // About 0.1 s; checking every dirty node for each paragraph took ~7 s.
    expect(performance.now() - start).toBeLessThan(2000);
    expect(loadedTexts(doc)).toHaveLength(5000);
  });
});

describe("two peers fix the same typo at once", () => {
  test("both fixes stay", () => {
    const network = createPeers(["Hello wrld!"], 2);
    for (const peer of network.peers) peer.update(() => $typeAt(0, 7, "o"));
    network.syncAsDocSync();
    for (const peer of network.peers)
      expect(peer.texts()).toStrictEqual(["Hello woorld!"]);
    expect(loadedTexts(network.server)).toStrictEqual(["Hello woorld!"]);
  });
});

describe("random sessions synced like DocSync", () => {
  /** One random step of one peer, decided only by `rng`. */
  function step(
    network: ReturnType<typeof createPeers>,
    rng: ReturnType<typeof randomizer>,
  ) {
    const peer = network.peers[rng.int(2)]!;
    const index = rng.int(peer.texts().length);
    const offset = rng.int(8);
    const roll = rng.next();
    if (roll < 0.35)
      peer.update(() => $typeAt(index, offset, rng.pick(["X", "ab"])));
    else if (roll < 0.45) peer.update(() => $enterAt(index, offset));
    else if (roll < 0.55 && index > 0)
      peer.update(() => $joinWithPrevious(index));
    else if (roll < 0.7) peer.update(() => $deleteAt(index, offset));
    else if (roll < 0.8) peer.undo();
    else if (roll < 0.85) peer.redo();
    else network.syncAsDocSync();
  }

  const showsItsDocument = (peer: Peer) =>
    expect(peer.texts()).toStrictEqual(loadedTexts(peer.doc));

  test.each(Array.from({ length: 20 }, (_, seed) => seed))(
    "seed %i: every peer ends with the server's text",
    (seed) => {
      const rng = randomizer(seed);
      const network = createPeers(["Hello", "World", "Third line"], 2);
      for (let index = 0; index < 40; index++) step(network, rng);
      network.syncAsDocSync();
      const expected = loadedTexts(network.server);
      for (const peer of network.peers) {
        showsItsDocument(peer);
        expect(peer.texts()).toStrictEqual(expected);
      }
    },
  );
});
