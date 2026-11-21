import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { Doc } from "@docukit/docnode";
import { createLexicalDocNodeConfig } from "@docukit/docnode-lexical";
import { DocNodePlugin } from "@docukit/docnode-lexical/react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from "lexical";

import { loadedTexts } from "./utils.js";

test("what the editor writes reaches the document", async () => {
  const doc = new Doc(createLexicalDocNodeConfig({ type: "root" }));
  doc.forceCommit();
  let editor: LexicalEditor | undefined;
  await render(
    <LexicalComposer
      initialConfig={{
        namespace: "react-plugin",
        onError: (error) => {
          throw error;
        },
      }}
    >
      <EditorRefPlugin
        editorRef={(value) => {
          editor = value ?? undefined;
        }}
      />
      <DocNodePlugin doc={doc} />
    </LexicalComposer>,
  );
  editor!.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode("Hello")),
      );
    },
    { discrete: true },
  );
  doc.forceCommit();
  expect(loadedTexts(doc)).toStrictEqual(["Hello"]);
});
