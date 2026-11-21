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
} from "lexical";

import { checkUndoManager } from "../docnode/utils.js";
import {
  $joinWithPrevious,
  createPeers,
  createSyncedEditor,
  loadedTexts,
} from "./utils.js";

const $removeParagraph = (index: number) =>
  $getRoot().getChildAtIndex(index)!.remove();

const stored = (doc: Doc) => JSON.stringify(doc.toJSON());

describe("a paragraph deleted in a letter-by-letter document", () => {
  test("is not stored with its letters", () => {
    const { doc, update } = createSyncedEditor(["Keep this", "Secret words"]);
    update(() => $removeParagraph(1));
    expect(stored(doc)).not.toContain("Secret");
    expect(loadedTexts(doc)).toStrictEqual(["Keep this"]);
  });

  test("replacing every paragraph keeps only the new text", () => {
    const { doc, update } = createSyncedEditor(["first draft", "of words"]);
    for (const round of ["alpha", "bravo", "charlie"]) {
      update(() => {
        $getRoot().clear();
        $getRoot().append(
          $createParagraphNode().append($createTextNode(`${round} one`)),
          $createParagraphNode().append($createTextNode(`${round} two`)),
        );
      });
    }
    for (const gone of ["draft", "alpha", "bravo"])
      expect(stored(doc)).not.toContain(gone);
    expect(loadedTexts(doc)).toStrictEqual(["charlie one", "charlie two"]);
  });

  test("comes back with undo, from the undo operation", () => {
    const { doc, editor } = createSyncedEditor([]);
    const edit = (change: () => void) =>
      editor.update(change, { discrete: true });
    checkUndoManager(2, doc, () => {
      edit(() =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode("Keep this")),
          $createParagraphNode().append($createTextNode("Secret words")),
        ),
      );
      edit(() => $removeParagraph(1));
    });
  });

  test("comes back with undo in a copy rebuilt from what was stored", () => {
    const { doc, update } = createSyncedEditor(["Keep this", "Secret words"]);
    update(() => $removeParagraph(1));
    const config = createLexicalDocNodeConfig({
      type: "root",
      undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
    });
    const copy = Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON());
    copy.forceCommit();
    syncLexicalWithDoc(createEditor({ namespace: "copy" }), copy);
    // The document no longer has the letters: only the history does.
    copy.undoManager.importHistory(doc.undoManager.exportHistory());
    copy.undoManager.undo();
    copy.forceCommit();
    expect(loadedTexts(copy)).toStrictEqual(["Keep this", "Secret words"]);
  });

  test("comes back for every peer when its author undoes, synced like DocSync", () => {
    const network = createPeers(["Keep this", "Secret words"]);
    const [author, other] = network.peers as [
      (typeof network.peers)[0],
      (typeof network.peers)[0],
    ];
    author.update(() => $removeParagraph(1));
    // Every peer, and the server, now stores the document without them.
    network.syncAsDocSync();
    expect(stored(network.server)).not.toContain("Secret");
    expect(other.texts()).toStrictEqual(["Keep this"]);
    author.undo();
    network.syncAsDocSync();
    for (const peer of network.peers)
      expect(peer.texts()).toStrictEqual(["Keep this", "Secret words"]);
    expect(loadedTexts(network.server)).toStrictEqual([
      "Keep this",
      "Secret words",
    ]);
  });

  test("wins over a concurrent join of it into its neighbour", () => {
    const network = createPeers(["Hello", "World"]);
    const [deleting, joining] = network.peers as [
      (typeof network.peers)[0],
      (typeof network.peers)[0],
    ];
    deleting.update(() => $removeParagraph(1));
    joining.update(() => $joinWithPrevious(1));
    network.syncAsDocSync();
    // Accepted: the joined text disappears with the deleted paragraph.
    for (const peer of network.peers)
      expect(peer.texts()).toStrictEqual(["Hello"]);
    expect(loadedTexts(network.server)).toStrictEqual(["Hello"]);
  });
});
