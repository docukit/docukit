"use client";

import { $createHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, type RootNode } from "lexical";
import { useState } from "react";
import { createDocId } from "../utils/docId";
import { EditorExample } from "./EditorExample";

function initializeHomeEditor(root: RootNode) {
  const heading = $createHeadingNode("h1");
  heading.append($createTextNode("This is a Lexical editor."));

  const p1 = $createParagraphNode();
  const syncIntro = $createTextNode(
    "It stays collaborative and in sync thanks to ",
  );
  const docNode = $createTextNode("DocNode");
  docNode.setFormat("bold");
  const and = $createTextNode(" and ");
  const docSync = $createTextNode("DocSync");
  docSync.setFormat("bold");
  const syncOutro = $createTextNode(
    ": type here or in the other panel — changes flow in real time.",
  );
  p1.append(syncIntro, docNode, and, docSync, syncOutro);

  const p2 = $createParagraphNode();
  const pitchStart = $createTextNode(
    "DocNode gives you type-safe documents and conflict-free merges. ",
  );
  const pitchSync = $createTextNode("DocSync");
  pitchSync.setFormat("bold");
  const pitchEnd = $createTextNode(
    " keeps every client in sync over the wire—no custom server logic required.",
  );
  p2.append(pitchStart, pitchSync, pitchEnd);

  root.append(heading, p1, p2);
}

export function HomeSyncedEditorsDemo() {
  const [docId, setDocId] = useState(createDocId);

  return (
    <section className="mx-auto max-w-7xl px-2 py-12 md:py-16">
      <div className="mb-10 text-center md:mb-14">
        <h2 className="text-fd-foreground mb-4 text-3xl font-bold tracking-tight md:text-4xl">
          See it in action
        </h2>
        <p className="text-fd-muted-foreground mx-auto max-w-2xl md:text-lg">
          Built with{" "}
          <code className="bg-fd-secondary text-fd-foreground rounded px-1.5 py-0.5 font-mono text-sm">
            docnode-lexical
          </code>{" "}
          and{" "}
          <code className="bg-fd-secondary text-fd-foreground rounded px-1.5 py-0.5 font-mono text-sm">
            docsync-react
          </code>
          .
        </p>
        <p className="text-fd-muted-foreground mx-auto max-w-2xl md:text-lg">
          Type in any editor, disconnect clients, or switch the document ID.
        </p>
      </div>
      <EditorExample
        docId={docId}
        initializeEditor={initializeHomeEditor}
        onDocIdChange={setDocId}
      />
    </section>
  );
}
