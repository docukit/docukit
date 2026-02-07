import {
  $getRoot,
  createEditor,
  type ParagraphNode,
  type SerializedParagraphNode,
  type SerializedTextNode,
} from "lexical";
import { describe, expect, test } from "vitest";

import {
  createLexicalDoc,
  syncLexicalWithDoc,
  LexicalDocNode,
} from "@docukit/docnode-lexical";

describe("docnode to lexical sync", () => {
  test("add paragraph to empty doc", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);

    // Initially empty
    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(0);
    });

    // Add a paragraph in DocNode
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

    const dnParagraph = doc.createNode(LexicalDocNode);
    dnParagraph.state.j.set(paragraphJson);
    doc.root.append(dnParagraph);
    doc.forceCommit(); // Force DocNode to commit and trigger onChange

    // Should sync to Lexical
    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      const firstChild = root.getFirstChild();
      expect(firstChild?.getType()).toBe("paragraph");
    });
  });

  test("add text to paragraph", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);

    // Create paragraph with text in DocNode
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

    const dnParagraph = doc.createNode(LexicalDocNode);
    const dnText = doc.createNode(LexicalDocNode);
    dnParagraph.state.j.set(paragraphJson);
    dnText.state.j.set(textJson);
    dnParagraph.append(dnText);
    doc.root.append(dnParagraph);
    doc.forceCommit();

    // Verify structure in Lexical
    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);

      const paragraph = root.getFirstChild() as ParagraphNode | undefined;
      expect(paragraph?.getType()).toBe("paragraph");
      expect(paragraph?.getChildrenSize()).toBe(1);

      const text = paragraph?.getFirstChild();
      expect(text?.getType()).toBe("text");
      expect(text?.getTextContent()).toBe("Hello, world!");
    });
  });

  test("add multiple paragraphs", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);

    // Create two paragraphs in DocNode
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

    const textJson1: SerializedTextNode = {
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "First",
      type: "text",
      version: 1,
    };

    const textJson2: SerializedTextNode = {
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "Second",
      type: "text",
      version: 1,
    };

    const dnP1 = doc.createNode(LexicalDocNode);
    const dnT1 = doc.createNode(LexicalDocNode);
    const dnP2 = doc.createNode(LexicalDocNode);
    const dnT2 = doc.createNode(LexicalDocNode);

    dnP1.state.j.set(paragraphJson);
    dnT1.state.j.set(textJson1);
    dnP2.state.j.set(paragraphJson);
    dnT2.state.j.set(textJson2);

    dnP1.append(dnT1);
    dnP2.append(dnT2);
    doc.root.append(dnP1, dnP2);
    doc.forceCommit();

    // Verify both paragraphs in Lexical
    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(2);

      const children: ParagraphNode[] = root.getChildren();
      expect(children[0]?.getFirstChild()?.getTextContent()).toBe("First");
      expect(children[1]?.getFirstChild()?.getTextContent()).toBe("Second");
    });
  });

  test("update existing text", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);

    // Create initial paragraph with text
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
      text: "Initial",
      type: "text",
      version: 1,
    };

    const dnParagraph = doc.createNode(LexicalDocNode);
    const dnText = doc.createNode(LexicalDocNode);
    dnParagraph.state.j.set(paragraphJson);
    dnText.state.j.set(textJson);
    dnParagraph.append(dnText);
    doc.root.append(dnParagraph);
    doc.forceCommit();

    // Verify initial state
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const text = (
        root.getFirstChild() as ParagraphNode | undefined
      )?.getFirstChild();
      expect(text?.getTextContent()).toBe("Initial");
    });

    // Update the text in DocNode
    const updatedTextJson: SerializedTextNode = {
      ...textJson,
      text: "Updated",
    };
    dnText.state.j.set(updatedTextJson);
    doc.forceCommit();

    // Verify updated state in Lexical
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const text = (
        root.getFirstChild() as ParagraphNode | undefined
      )?.getFirstChild();
      expect(text?.getTextContent()).toBe("Updated");
    });
  });

  test("remove paragraph", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);

    // Create two paragraphs
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

    const textJson1: SerializedTextNode = {
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "First",
      type: "text",
      version: 1,
    };

    const textJson2: SerializedTextNode = {
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "Second",
      type: "text",
      version: 1,
    };

    const dnP1 = doc.createNode(LexicalDocNode);
    const dnT1 = doc.createNode(LexicalDocNode);
    const dnP2 = doc.createNode(LexicalDocNode);
    const dnT2 = doc.createNode(LexicalDocNode);

    dnP1.state.j.set(paragraphJson);
    dnT1.state.j.set(textJson1);
    dnP2.state.j.set(paragraphJson);
    dnT2.state.j.set(textJson2);

    dnP1.append(dnT1);
    dnP2.append(dnT2);
    doc.root.append(dnP1, dnP2);
    doc.forceCommit();

    // Verify initial state
    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(2);
    });

    // Remove first paragraph from DocNode
    dnP1.delete();
    doc.forceCommit();

    // Verify only second paragraph remains in Lexical
    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      const text = (
        root.getFirstChild() as ParagraphNode | undefined
      )?.getFirstChild();
      expect(text?.getTextContent()).toBe("Second");
    });
  });

  test("complex edit sequence", () => {
    const editor = createEditor({
      namespace: "MyEditor",
      onError: (error) => {
        console.error(error);
      },
    });
    const doc = createLexicalDoc();
    syncLexicalWithDoc(editor, doc);

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

    // Step 1: Add initial content
    const dnP1 = doc.createNode(LexicalDocNode);
    const dnT1 = doc.createNode(LexicalDocNode);
    const dnP2 = doc.createNode(LexicalDocNode);
    const dnT2 = doc.createNode(LexicalDocNode);

    dnP1.state.j.set(paragraphJson);
    dnT1.state.j.set({
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "One",
      type: "text",
      version: 1,
    } as SerializedTextNode);

    dnP2.state.j.set(paragraphJson);
    dnT2.state.j.set({
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "Two",
      type: "text",
      version: 1,
    } as SerializedTextNode);

    dnP1.append(dnT1);
    dnP2.append(dnT2);
    doc.root.append(dnP1, dnP2);
    doc.forceCommit();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(2);
    });

    // Step 2: Add paragraph in the middle
    const dnPNew = doc.createNode(LexicalDocNode);
    const dnTNew = doc.createNode(LexicalDocNode);
    dnPNew.state.j.set(paragraphJson);
    dnTNew.state.j.set({
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text: "Middle",
      type: "text",
      version: 1,
    } as SerializedTextNode);
    dnPNew.append(dnTNew);
    dnP1.insertAfter(dnPNew);
    doc.forceCommit();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(3);
      const children: ParagraphNode[] = root.getChildren();
      expect(children[1]?.getFirstChild()?.getTextContent()).toBe("Middle");
    });

    // Step 3: Remove middle paragraph
    dnPNew.delete();
    doc.forceCommit();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(2);
      const children: ParagraphNode[] = root.getChildren();
      expect(children[0]?.getFirstChild()?.getTextContent()).toBe("One");
      expect(children[1]?.getFirstChild()?.getTextContent()).toBe("Two");
    });
  });
});
