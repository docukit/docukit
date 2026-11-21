import { describe, expect, test } from "vitest";
import { Doc, type JsonTree } from "@docukit/docnode";
import {
  createLexicalDocNodeConfig,
  syncLexicalWithDoc,
} from "@docukit/docnode-lexical";
import { $createLinkNode, LinkNode } from "@lexical/link";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  createEditor,
  ElementNode,
  type SerializedElementNode,
} from "lexical";

const config = () => createLexicalDocNodeConfig({ type: "root" });

/** An inline element of the app's own. */
class ChipNode extends ElementNode {
  static override getType() {
    return "chip";
  }
  static override clone(node: ChipNode) {
    return new ChipNode(node.__key);
  }
  static override importJSON(json: SerializedElementNode) {
    return new ChipNode().updateFromJSON(json);
  }
  override isInline() {
    return true;
  }
}

const createLinkEditor = () =>
  createEditor({
    namespace: "entry-points",
    nodes: [LinkNode, ChipNode],
    onError: (error) => {
      throw error;
    },
  });

/** Bold, italic, a link, a line break and a tab, in two paragraphs. */
function $writeContent() {
  const link = $createLinkNode("https://docukit.dev").append(
    $createTextNode("brave "),
    $createTextNode("new").toggleFormat("italic"),
  );
  $getRoot().append(
    $createParagraphNode().append(
      $createTextNode("Hello "),
      link,
      $createTextNode(" world").toggleFormat("bold"),
      $createLineBreakNode(),
      $createTabNode(),
      $createTextNode("indented"),
    ),
    $createParagraphNode().append($createTextNode("Second")),
    $createParagraphNode(),
  );
}

const contentOf = (editor: ReturnType<typeof createLinkEditor>) =>
  editor.getEditorState().toJSON();

/** A paragraph with "Hello", as the former "node" mode stored it. */
const NODE_DOCUMENT: JsonTree = [
  "01kc52hq510g6y44jhq0wqrjb3",
  "root",
  {},
  [
    [
      "01kc52hq510g6y44jhq0wqrjb4",
      "l",
      { j: '{"children":[]}' },
      [
        [
          "01kc52hq510g6y44jhq0wqrjb5",
          "l",
          { j: '{"text":"Hello","type":"text","version":1}' },
        ],
      ],
    ],
  ],
];

describe("the entry point", () => {
  test("loads what its editor wrote as the editor showed it", () => {
    const doc = new Doc(config());
    doc.forceCommit();
    const editor = createLinkEditor();
    syncLexicalWithDoc(editor, doc);
    editor.update($writeContent, { discrete: true });

    const copy = Doc.fromJSON({ ...config(), id: doc.root.id }, doc.toJSON());
    copy.forceCommit();
    const loaded = createLinkEditor();
    syncLexicalWithDoc(loaded, copy);
    expect(contentOf(loaded)).toStrictEqual(contentOf(editor));
  });

  test('a document of the former "node" mode throws, pointing to a converter', () => {
    expect(() => Doc.fromJSON(config(), NODE_DOCUMENT)).toThrow(
      'Add `openNodeDocuments` from "@docukit/docnode-lexical/compat"',
    );
  });

  test("a document of another config throws", () => {
    const doc = new Doc({ type: "root", extensions: [] });
    expect(() => syncLexicalWithDoc(createLinkEditor(), doc)).toThrow(
      "needs a document made with createLexicalDocNodeConfig",
    );
  });
});
