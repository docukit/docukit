import { describe, expect, test } from "vitest";
import { $insertList } from "@lexical/list";
import { $toggleLink } from "@lexical/link";
import { $createHeadingNode } from "@lexical/rich-text";
import { _INTERNAL_textStore, Doc, type Operations } from "@docukit/docnode";
import {
  createLexicalDocNodeConfig,
  syncLexicalWithDoc,
} from "@docukit/docnode-lexical";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
} from "lexical";

import { createCluster, createFuzzEditor, loadedView, viewOf } from "./fuzz.js";

const P = "\x7f";

/** A letter-by-letter document bound to an editor, with its root text. */
const config = () =>
  createLexicalDocNodeConfig({
    type: "root",
    undoManager: { maxUndoSteps: 100, mergeInterval: 0 },
  });

function bound() {
  const doc = Doc.fromJSON(config(), [
    "01kc52hq510g6y44jhq0wqrjb3",
    "root",
    { "~textConflicts": '"letter"' },
  ]);
  doc.forceCommit();
  const editor = createFuzzEditor();
  syncLexicalWithDoc(editor, doc);
  const text = () => _INTERNAL_textStore(doc).textOf(doc.root.id);
  const update = (change: () => void) => {
    let changes = 0;
    const off = doc.onChange(() => changes++);
    editor.update(change, { discrete: true });
    doc.forceCommit();
    off();
    return changes;
  };
  return { doc, editor, text, update };
}

const paragraphs =
  (...texts: string[]) =>
  () =>
    $getRoot().append(
      ...texts.map((text) =>
        $createParagraphNode().append($createTextNode(text)),
      ),
    );

const firstText = (index: number) => {
  const block = $getRoot().getChildAtIndex<ElementNode>(index)!;
  const node = block.getFirstChild();
  if (!$isTextNode(node)) throw new Error("Expected text");
  return node;
};

const reloaded = (doc: Doc, editor: LexicalEditor) =>
  expect(loadedView(doc.toJSON())).toBe(viewOf(editor));

describe("the root holds one text, a line per block", () => {
  test("paragraphs are lines ended by a paragraph letter", () => {
    const { doc, editor, text, update } = bound();
    update(paragraphs("First", "Second"));
    expect(text()).toBe(`First${P}Second${P}`);
    expect(doc.root.first).toBeUndefined();
    reloaded(doc, editor);
  });

  test("typing, Enter and Backspace edit letters of that text", () => {
    const { doc, editor, text, update } = bound();
    update(paragraphs("Hello world"));
    update(() => firstText(0).select(5, 5).insertText(","));
    expect(text()).toBe(`Hello, world${P}`);
    update(() => firstText(0).select(6, 6).insertParagraph());
    expect(text()).toBe(`Hello,${P} world${P}`);
    update(() => firstText(1).select(0, 0).deleteCharacter(true));
    expect(text()).toBe(`Hello, world${P}`);
    reloaded(doc, editor);
  });

  test("removing a paragraph deletes its line", () => {
    const { text, update } = bound();
    update(paragraphs("a", "b", "c"));
    update(() => $getRoot().getChildAtIndex(1)!.remove());
    expect(text()).toBe(`a${P}c${P}`);
  });

  test("a node made dirty without a change sends nothing", () => {
    const { update } = bound();
    update(paragraphs("Initial"));
    const changes = update(() => {
      $getRoot().getFirstChildOrThrow<ElementNode>().getWritable();
      firstText(0).getWritable();
    });
    expect(changes).toBe(0);
  });

  test("blocks, formats and links are letter state, and load back the same", () => {
    const { doc, editor, update } = bound();
    update(paragraphs("Title", "one", "two", "plain text here"));
    update(() =>
      $getRoot()
        .getFirstChildOrThrow<ElementNode>()
        .replace($createHeadingNode("h2"), true),
    );
    update(() => {
      firstText(1).select(0, 0);
      $insertList("bullet");
    });
    update(() => firstText(3).select(0, 5).formatText("bold"));
    update(() => {
      const last = $getRoot().getLastChildOrThrow<ElementNode>();
      const node = last.getLastChild();
      if ($isTextNode(node)) node.select(1, 4);
      $toggleLink("https://example.com");
    });
    reloaded(doc, editor);
  });
});

describe("undo", () => {
  test("brings back a deleted paragraph and its format", () => {
    const { doc, editor, text, update } = bound();
    update(paragraphs("Keep", "Secret"));
    update(() => firstText(1).select(0, 3).formatText("bold"));
    const before = viewOf(editor);
    update(() => $getRoot().getChildAtIndex(1)!.remove());
    doc.undoManager.undo();
    doc.forceCommit();
    expect(text()).toBe(`Keep${P}Secret${P}`);
    expect(viewOf(editor)).toBe(before);
    doc.undoManager.redo();
    doc.forceCommit();
    expect(text()).toBe(`Keep${P}`);
  });
});

/**
 * Two bound peers of one document that sync through a server (see
 * `createCluster`): the first one's edits go first.
 */
function pair(...texts: string[]) {
  const { peers, sync } = createCluster(2, texts);
  return { peers, sync };
}

describe("letters inherit formats and links", () => {
  test("a letter typed in bold text sends no state", () => {
    const sent = (bold: boolean) => {
      const { doc, update } = bound();
      update(paragraphs("Hello world"));
      if (bold) update(() => firstText(0).select(0, 11).formatText("bold"));
      const batches: Operations[] = [];
      doc.onChange((event) => batches.push(event.operations));
      update(() => firstText(0).select(3, 3).insertText("x"));
      return JSON.stringify(batches);
    };
    expect(sent(true).length).toBe(sent(false).length);
  });

  test("text typed at the end of a word a peer bolds is bold too", () => {
    const { peers, sync } = pair("Hello world");
    const [a, b] = peers as [(typeof peers)[0], (typeof peers)[0]];
    a.update(() => firstText(0).select(0, 5).formatText("bold"));
    b.update(() => firstText(0).select(5, 5).insertText("!"));
    sync();
    expect(viewOf(a.editor)).toBe(viewOf(b.editor));
    a.editor.getEditorState().read(() => {
      expect(firstText(0).getTextContent()).toBe("Hello!");
      expect(firstText(0).hasFormat("bold")).toBe(true);
    });
  });

  test("text typed inside a link a peer adds is in it, at its edge is not", () => {
    const { peers, sync } = pair("see here now");
    const [a, b] = peers as [(typeof peers)[0], (typeof peers)[0]];
    a.update(() => {
      firstText(0).select(4, 8);
      $toggleLink("https://x");
    });
    b.update(() => firstText(0).select(6, 6).insertText("-"));
    b.update(() => firstText(0).select(9, 9).insertText("!"));
    sync();
    expect(viewOf(a.editor)).toBe(viewOf(b.editor));
    expect(viewOf(a.editor)).toContain("he-re");
    expect(viewOf(a.editor)).not.toContain("he-re!");
  });
});

describe("undo of a delete", () => {
  test("brings the same letters back: a double undo does not duplicate", () => {
    const { peers, sync } = pair("one two three");
    const [a, b] = peers as [(typeof peers)[0], (typeof peers)[0]];
    a.update(() => firstText(0).select(4, 8).removeText());
    b.update(() => firstText(0).select(4, 8).removeText());
    sync();
    a.doc.undoManager.undo();
    b.doc.undoManager.undo();
    a.doc.forceCommit();
    b.doc.forceCommit();
    sync();
    expect(viewOf(a.editor)).toBe(viewOf(b.editor));
    a.editor
      .getEditorState()
      .read(() => expect($getRoot().getTextContent()).toBe("one two three"));
  });
});
