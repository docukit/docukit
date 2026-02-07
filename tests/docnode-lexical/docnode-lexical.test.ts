import { test, expect, describe } from "vitest";
import { Doc } from "@docukit/docnode";
import {
  createLexicalDoc,
  docToLexical,
  LexicalDocNode,
} from "@docukit/docnode-lexical";
import { assertJson } from "../docnode/utils.js";
import {
  createEditor,
  type SerializedParagraphNode,
  type SerializedTextNode,
} from "lexical";

describe("docnode to lexical", () => {
  test.todo("no doc provided", () => {
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
    assertJson(doc, ["root", {}, [["l", { j: rootJson }]]]);
  });

  test("doc provided", () => {
    const doc = new Doc({ extensions: [{ nodes: [LexicalDocNode] }] });
    const paragraphJson: SerializedParagraphNode = {
      type: "paragraph",
      version: 1,
      children: [],
      format: "",
      indent: 0,
      direction: "ltr",
      textFormat: 0,
      textStyle: "",
    };
    const textJson: SerializedTextNode = {
      type: "text",
      version: 1,
      text: "Hello, world!",
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
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
    docToLexical(editor, doc);
    expect(doc).toBeInstanceOf(Doc);
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
