import { _INTERNAL_textStore, type Doc } from "@docukit/docnode";
import { $createNodeSelection, $getRoot, $setSelection } from "lexical";
import { describe, expect, test } from "vitest";

import {
  $deleteAt,
  $enterAt,
  $joinWithPrevious,
  $typeAt,
  createMountedPeers,
  ImageNode,
} from "../utils.js";

/**
 * Remote cursors: each end of a selection is the
 * letter right after it (or, at the end of the text, the one before it), so
 * edits of others move the cursor with the text around it.
 */

/** Two peers; `a` has its caret at `offset` of a paragraph, `b` shows it. */
function peersWithCaret(paragraphs: string[], index: number, offset: number) {
  const peers = createMountedPeers(paragraphs);
  peers.a.select(index, offset);
  peers.b.show(peers.a);
  return peers;
}

/** The root text of a document, edited with the DocNode API. */
const rootText = (doc: Doc) => {
  const store = _INTERNAL_textStore(doc);
  const id = doc.root.id;
  const edit = (change: () => void) => {
    change();
    doc.forceCommit();
  };
  return {
    append: (text: string) =>
      edit(() => store.insert(doc, id, store.lengthOf(id), text)),
    clear: () => edit(() => store.delete(doc, id, 0, store.lengthOf(id))),
  };
};

describe("a remote caret", () => {
  test("is shown where the other user put it", () => {
    const { a, b } = peersWithCaret(["hello", "world"], 1, 2);
    expect(b.caretOf(a)).toStrictEqual(["hello", "wo|rld"]);
  });

  test("moves with its letters when text is typed before it", () => {
    const { a, b } = peersWithCaret(["hello", "world"], 1, 2);
    b.update(() => $typeAt(1, 0, "XY"));
    b.update(() => $enterAt(0, 2));
    expect(b.caretOf(a)).toStrictEqual(["he", "llo", "XYwo|rld"]);
  });

  test("stays before the letter after it when text is typed at it", () => {
    const { a, b } = peersWithCaret(["hello"], 0, 2);
    b.update(() => $typeAt(0, 2, "Z"));
    expect(b.caretOf(a)).toStrictEqual(["heZ|llo"]);
  });

  test("at the end of a paragraph stays at its end", () => {
    const { a, b } = peersWithCaret(["hello", "world"], 0, 5);
    b.update(() => $typeAt(0, 5, "!"));
    expect(b.caretOf(a)).toStrictEqual(["hello!|", "world"]);
  });

  test("in an empty paragraph", () => {
    const { a, b } = peersWithCaret(["hello", "", "world"], 1, 0);
    expect(b.caretOf(a)).toStrictEqual(["hello", "|", "world"]);
  });

  test("is where its letter was once the letter is deleted", () => {
    const { a, b } = peersWithCaret(["hello"], 0, 2);
    b.update(() => $deleteAt(0, 2));
    expect(b.caretOf(a)).toStrictEqual(["he|lo"]);
  });

  test("at the end of a paragraph joined with the next one", () => {
    const { a, b } = peersWithCaret(["hello", "world"], 0, 5);
    b.update(() => $joinWithPrevious(1));
    expect(b.caretOf(a)).toStrictEqual(["hello|world"]);
  });

  test("on letters not received yet shows once they are", () => {
    const { a, b, sync } = createMountedPeers(["hello"]);
    a.update(() => $typeAt(0, 5, " you"));
    a.select(0, 7);
    b.show(a);
    expect(b.caretOf(a)).toStrictEqual(["hello"]);
    sync();
    expect(b.caretOf(a)).toStrictEqual(["hello y|ou"]);
  });

  test("of a deleted paragraph is right before the image after it", () => {
    const { a, b, sync } = createMountedPeers(["hello", "world"]);
    a.update(() =>
      $getRoot().getLastChildOrThrow().insertBefore(new ImageNode()),
    );
    sync();
    a.select(0, 5);
    b.show(a);
    b.update(() => $getRoot().getFirstChildOrThrow().remove());
    expect(b.caretOf(a)).toStrictEqual(["|", "world"]);
  });
});

describe("a remote caret at the end of the text", () => {
  // Concurrent edits can leave letters after the last paragraph letter.
  const withOpenLine = () => {
    const peers = createMountedPeers(["hello"]);
    rootText(peers.a.doc).append("tail");
    peers.sync();
    peers.a.select(1, 4);
    peers.b.show(peers.a);
    return peers;
  };

  test("after letters without a paragraph letter", () => {
    const { a, b } = withOpenLine();
    expect(b.caretOf(a)).toStrictEqual(["hello", "tail|"]);
  });

  test("is where its letter was once the letter is deleted", () => {
    const { a, b } = withOpenLine();
    b.update(() => $deleteAt(1, 3));
    expect(b.caretOf(a)).toStrictEqual(["hello", "tai|"]);
  });

  test("is at the end of the last paragraph once its line is deleted", () => {
    const { a, b } = withOpenLine();
    b.update(() => $getRoot().getLastChildOrThrow().remove());
    expect(b.caretOf(a)).toStrictEqual(["hello|"]);
  });

  test("is not shown once the whole text is deleted", () => {
    const { a, b } = peersWithCaret(["hello"], 0, 2);
    rootText(b.doc).clear();
    expect(b.caretOf(a)).toStrictEqual([]);
  });
});

describe("local presence", () => {
  test("is cleared when the selection is not in text", () => {
    const { a } = createMountedPeers(["hello"]);
    a.select(0, 2);
    expect(a.presence).toBeDefined();
    a.update(() => {
      const selection = $createNodeSelection();
      selection.add($getRoot().getFirstChildOrThrow().getKey());
      $setSelection(selection);
    });
    expect(a.presence).toBeUndefined();
  });
});
