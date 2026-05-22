"use client";

import type React from "react";
import { $createParagraphNode, $createTextNode, type RootNode } from "lexical";
import { Suspense } from "react";
import {
  EditorExample,
  EditorExampleLoading,
} from "@/components/examples/editor/EditorExample";
import { useDocId } from "@/components/examples/utils/useDocId";

function initializeExamplesEditor(root: RootNode) {
  const p1 = $createParagraphNode();
  const p2 = $createParagraphNode();
  const p3 = $createParagraphNode();

  p1.append($createTextNode("Item one."));
  p2.append($createTextNode("Item two."));
  p3.append($createTextNode("Item three."));

  root.append(p1, p2, p3);
}

function EditorPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="px-4 py-6 md:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Lexical Editor Example
      </h1>
      {children}
    </main>
  );
}

function EditorPageContent() {
  const docId = useDocId("/examples/editor");

  if (!docId) {
    return (
      <EditorPageShell>
        <EditorExampleLoading />
      </EditorPageShell>
    );
  }

  return (
    <EditorPageShell>
      <EditorExample
        docId={docId}
        initializeEditor={initializeExamplesEditor}
      />
    </EditorPageShell>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <EditorPageShell>
          <EditorExampleLoading />
        </EditorPageShell>
      }
    >
      <EditorPageContent />
    </Suspense>
  );
}
