import { Doc } from "@docukit/docnode";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ParagraphNode,
  type TextNode,
} from "lexical";
import { describe, expect, test } from "vitest";

import { syncLexicalWithDoc } from "@docukit/docnode-lexical";
import { createLexicalDoc, createSyncedEditor, loadedTexts } from "./utils.js";

describe("an empty document", () => {
  test("shows an empty editor", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);
    expect(doc).toBeInstanceOf(Doc);
    const jsonEditorState = editor.getEditorState().toJSON();
    expect(jsonEditorState).toStrictEqual({
      root: {
        children: [],
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    });
    const rootJson = JSON.stringify(jsonEditorState.root);
    expect(rootJson).toStrictEqual(
      '{"children":[],"direction":null,"format":"","indent":0,"type":"root","version":1}',
    );
  });
});

describe("updates that keep every child in place", () => {
  const paragraph = (index: number) =>
    $getRoot().getChildAtIndex<ParagraphNode>(index)!;

  test("typing in one paragraph only updates that paragraph", () => {
    const { doc, update } = createSyncedEditor(["a", "b", "c"]);
    const diff = update(() => {
      paragraph(1).getFirstChild<TextNode>()!.setTextContent("bX");
    });
    expect(loadedTexts(doc)).toStrictEqual(["a", "bX", "c"]);
    expect(diff?.inserted.size).toBe(0);
    expect(diff?.deleted.size).toBe(0);
    expect(diff?.moved.size).toBe(0);
  });

  test("swapping two paragraphs is still synced", () => {
    const { doc, update } = createSyncedEditor(["a", "b", "c"]);
    update(() => paragraph(0).insertBefore(paragraph(1)));
    expect(loadedTexts(doc)).toStrictEqual(["b", "a", "c"]);
  });

  test("swapping text nodes between paragraphs is still synced", () => {
    const { doc, update } = createSyncedEditor(["a", "b"]);
    update(() => {
      const [first, second] = [paragraph(0), paragraph(1)];
      const [a, b] = [first.getFirstChild()!, second.getFirstChild()!];
      first.append(b);
      second.append(a);
    });
    expect(loadedTexts(doc)).toStrictEqual(["b", "a"]);
  });

  test("replacing a paragraph with a new one is still synced", () => {
    const { doc, update } = createSyncedEditor(["a", "b", "c"]);
    update(() => {
      paragraph(1).replace($createParagraphNode().append($createTextNode("z")));
    });
    expect(loadedTexts(doc)).toStrictEqual(["a", "z", "c"]);
  });
});
