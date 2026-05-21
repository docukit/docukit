"use client";

import type React from "react";
import { Suspense } from "react";
import {
  EditorExample,
  EditorExampleLoading,
} from "@/components/examples/editor/EditorExample";
import { useDocId } from "@/components/examples/utils/useDocId";

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
      <EditorExample docId={docId} />
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
