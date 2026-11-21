import { describe, expect, test } from "vitest";
import { Doc, type JsonTree } from "@docukit/docnode";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

import {
  converted,
  FIXTURES,
  connect,
  letterConfig,
  mainDocument,
  openLetter,
  stateOf,
  textsOf,
} from "./utils.js";

const ID = "01kc52hq510g6y44jhq0wqrjb3";
const LETTER_MODE = { "~textConflicts": "letter" };

const $appendParagraph = () =>
  $getRoot().append($createParagraphNode().append($createTextNode("Added")));
/** Edits a letter the conversion wrote, if there is one. */
const $typeInFirstText = () =>
  $getRoot().getAllTextNodes()[0]?.spliceText(0, 0, "B: ", true);

describe.each(FIXTURES)("$name", ({ id, json, state }) => {
  test("opens in letter mode as it opened in node mode", () => {
    const opened = openLetter(json, id);
    expect(opened.state).toStrictEqual(state);
    expect(opened.doc.toJSON()[2]).toStrictEqual(LETTER_MODE);
  });

  test("every replica converts it the same way", () => {
    expect(converted(json, id)).toStrictEqual(converted(json, id));
  });

  test("replicas that converted it on their own edit it together", () => {
    const a = openLetter(json, id);
    const b = openLetter(json, id);
    const sync = connect(a.doc, b.doc);
    a.editor.update($appendParagraph, { discrete: true });
    b.editor.update($typeInFirstText, { discrete: true });
    sync();
    expect(stateOf(b.editor)).toStrictEqual(stateOf(a.editor));
    expect(textsOf(a.editor).at(-1)).toBe("Added");
  });
});

test("a letter document loads as it is", () => {
  const doc = new Doc(letterConfig());
  doc.forceCommit();
  const json = converted(mainDocument(ID, ["Hello", "world"]), ID);
  expect(converted(json, ID)).toStrictEqual(json);
});

test("a large document", () => {
  const texts = Array.from({ length: 10_000 }, (_, i) => `Paragraph ${i}`);
  const { editor } = openLetter(mainDocument(ID, texts), ID);
  expect(textsOf(editor)).toStrictEqual(texts);
});

describe("a stored document it cannot read throws", () => {
  const error = 'Could not convert a stored "node" document to "letter"';
  const lexical = (j: string): JsonTree => [
    ID,
    "docnode-lexical",
    {},
    [["a", "l", { j }]],
  ];

  test.each([
    {
      name: "a DocNode of a type it does not know",
      json: [ID, "docnode-lexical", {}, [["a", "x", {}]]] satisfies JsonTree,
      reason: "'x' that was not registered",
    },
    {
      name: "a DocNode that is not a Lexical node",
      json: [
        ID,
        "docnode-lexical",
        {},
        [["a", "docnode-lexical", {}]],
      ] satisfies JsonTree,
      reason: "You cannot insert nodes of type 'root'",
    },
    {
      name: "a Lexical node the editor does not know",
      json: lexical(JSON.stringify({ type: "image", version: 1 })),
      reason: "image",
    },
    {
      name: "a Lexical node that is not JSON",
      json: lexical("{"),
      reason: "JSON",
    },
  ])("$name", ({ json, reason }) => {
    expect(() => converted(json, ID)).toThrow(error);
    expect(() => converted(json, ID)).toThrow(reason);
  });
});
