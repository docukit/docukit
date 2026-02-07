import { Doc, type DocNode } from "@docukit/docnode";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ParagraphNode,
  type TextNode,
  type SerializedParagraphNode,
  type SerializedTextNode,
} from "lexical";
import { describe, expect, test } from "vitest";

import {
  createLexicalDoc,
  docToLexical,
  LexicalDocNode,
} from "@docukit/docnode-lexical";
import { assertJson } from "../docnode/utils.js";

describe("docnode to lexical", () => {
  test("no doc provided", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);
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

  test("doc provided", () => {
    const doc = new Doc({ extensions: [{ nodes: [LexicalDocNode] }] });
    const paragraphJson: SerializedParagraphNode = {
      children: [],
      direction: "ltr",
      format: "",
      indent: 0,
      textFormat: 0,
      textStyle: "",
      type: "paragraph",
      version: 1,
    };
    const textJson: SerializedTextNode = {
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "Hello, world!",
      type: "text",
      version: 1,
    };

    const dnParagraph1 = doc.createNode(LexicalDocNode);
    const dnParagraph2 = doc.createNode(LexicalDocNode);
    const dnText1 = doc.createNode(LexicalDocNode);
    const dnText2 = doc.createNode(LexicalDocNode);

    dnParagraph1.state.j.set(paragraphJson);
    dnParagraph2.state.j.set(paragraphJson);
    dnText1.state.j.set(textJson);
    dnText2.state.j.set(textJson);

    dnParagraph1.append(dnText1);
    dnParagraph2.append(dnText2);
    doc.root.append(dnParagraph1, dnParagraph2);
    doc.forceCommit(); // Commit before creating editor to avoid transaction error

    assertJson(doc, [
      "root",
      {},
      [
        [
          "l",
          { j: JSON.stringify(paragraphJson) },
          [["l", { j: JSON.stringify(textJson) }]],
        ],
        [
          "l",
          { j: JSON.stringify(paragraphJson) },
          [["l", { j: JSON.stringify(textJson) }]],
        ],
      ],
    ]);

    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc2 = createLexicalDoc();
    docToLexical(editor, doc2);
    expect(doc2).toBeInstanceOf(Doc);
    const jsonEditorState = editor.getEditorState().toJSON();
    expect(jsonEditorState).toStrictEqual({
      root: {
        children: [
          {
            ...paragraphJson,
            children: [textJson],
          },
          {
            ...paragraphJson,
            children: [textJson],
          },
        ],
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    });
  });
});

describe("lexical to docnode sync", () => {
  test("add paragraph to empty editor", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);

    // Initially empty
    expect(doc.root.first).toBeUndefined();

    // Add a paragraph in Lexical
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
      },
      { discrete: true },
    );

    // Should sync to DocNode synchronously
    expect(doc.root.first).toBeDefined();
    const docChild = doc.root.first!;
    expect(docChild.is(LexicalDocNode)).toBe(true);
    const json = (docChild as DocNode<typeof LexicalDocNode>).state.j.get();
    expect(json.type).toBe("paragraph");
  });

  test("add text to paragraph", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);

    // Add paragraph with text
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode("Hello, world!");
        paragraph.append(text);
        root.append(paragraph);
      },
      { discrete: true },
    );

    // Verify structure in DocNode
    expect(doc.root.first).toBeDefined();
    const docParagraph = doc.root.first as DocNode<typeof LexicalDocNode>;
    expect(docParagraph.is(LexicalDocNode)).toBe(true);

    const paragraphJson = docParagraph.state.j.get();
    expect(paragraphJson.type).toBe("paragraph");

    // Check text node
    const docText = docParagraph.first as DocNode<typeof LexicalDocNode>;
    expect(docText.is(LexicalDocNode)).toBe(true);
    const textJson = docText.state.j.get();
    expect(textJson.type).toBe("text");
    expect((textJson as SerializedTextNode).text).toBe("Hello, world!");
  });

  test("add multiple paragraphs", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);

    // Add two paragraphs
    editor.update(
      () => {
        const root = $getRoot();
        const p1 = $createParagraphNode();
        const t1 = $createTextNode("First");
        p1.append(t1);

        const p2 = $createParagraphNode();
        const t2 = $createTextNode("Second");
        p2.append(t2);

        root.append(p1, p2);
      },
      { discrete: true },
    );

    // Verify both paragraphs
    expect(doc.root.first).toBeDefined();
    expect(doc.root.first!.next).toBeDefined();

    const docP1 = doc.root.first!;
    const text1 = (docP1.first as DocNode<typeof LexicalDocNode>).state.j.get()
      .text;
    expect(text1).toBe("First");

    const docP2 = docP1.next!;
    const text2 = (docP2.first as DocNode<typeof LexicalDocNode>).state.j.get()
      .text;
    expect(text2).toBe("Second");
  });

  test("update existing text", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);

    // Add initial text
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode("Initial");
        paragraph.append(text);
        root.append(paragraph);
      },
      { discrete: true },
    );

    // Verify initial state
    const docText1 = doc.root.first!.first as DocNode<typeof LexicalDocNode>;
    expect(docText1.state.j.get().text).toBe("Initial");

    // Update the text
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = root.getFirstChild() as ParagraphNode | undefined;
        const text = paragraph?.getFirstChild() as TextNode | undefined;
        if (text) {
          text.getWritable().setTextContent("Updated");
        }
      },
      { discrete: true },
    );

    // Verify updated state
    const docText2 = doc.root.first!.first as DocNode<typeof LexicalDocNode>;
    expect(docText2.state.j.get().text).toBe("Updated");
  });

  test("remove paragraph", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);

    // Add two paragraphs
    editor.update(
      () => {
        const root = $getRoot();
        const p1 = $createParagraphNode();
        p1.append($createTextNode("First"));
        const p2 = $createParagraphNode();
        p2.append($createTextNode("Second"));
        root.append(p1, p2);
      },
      { discrete: true },
    );

    expect(doc.root.first).toBeDefined();
    expect(doc.root.first!.next).toBeDefined();

    // Remove first paragraph
    editor.update(
      () => {
        const root = $getRoot();
        const first = root.getFirstChild();
        first?.remove();
      },
      { discrete: true },
    );

    // Verify only second paragraph remains
    expect(doc.root.first).toBeDefined();
    expect(doc.root.first!.next).toBeUndefined();
    const remaining = doc.root.first!.first as DocNode<typeof LexicalDocNode>;
    expect(remaining.state.j.get().text).toBe("Second");
  });

  test("complex edit sequence", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    docToLexical(editor, doc);

    // Step 1: Add initial content
    editor.update(
      () => {
        const root = $getRoot();
        const p1 = $createParagraphNode();
        p1.append($createTextNode("One"));
        const p2 = $createParagraphNode();
        p2.append($createTextNode("Two"));
        root.append(p1, p2);
      },
      { discrete: true },
    );
    expect(doc.root.first).toBeDefined();
    expect(doc.root.first!.next).toBeDefined();

    // Step 2: Add paragraph in the middle
    editor.update(
      () => {
        const root = $getRoot();
        const pNew = $createParagraphNode();
        pNew.append($createTextNode("Middle"));
        const firstChild = root.getFirstChild();
        if (firstChild) {
          firstChild.insertAfter(pNew);
        }
      },
      { discrete: true },
    );
    expect(doc.root.first).toBeDefined();
    expect(doc.root.first!.next).toBeDefined();
    expect(doc.root.first!.next!.next).toBeDefined();
    const middleText = (
      doc.root.first!.next!.first as DocNode<typeof LexicalDocNode>
    ).state.j.get().text;
    expect(middleText).toBe("Middle");

    // Step 3: Remove middle paragraph
    editor.update(
      () => {
        const root = $getRoot();
        const children = root.getChildren();
        if (children[1]) {
          children[1].remove();
        }
      },
      { discrete: true },
    );
    expect(doc.root.first).toBeDefined();
    expect(doc.root.first!.next).toBeDefined();
    expect(doc.root.first!.next!.next).toBeUndefined();
  });
});
