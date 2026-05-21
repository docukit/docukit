"use client";

import { Suspense } from "react";
import { EditorExample } from "@/components/examples/editor/EditorExample";
import { useDocId } from "@/components/examples/utils/useDocId";

function EditorPageContent() {
  const docId = useDocId("/examples/editor");

  if (!docId) return null;

  return (
    <main className="px-4 py-6 md:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Lexical Editor Example
      </h1>
      <EditorExample docId={docId} />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={<div className="text-fd-muted-foreground p-4">Loading...</div>}
    >
      <EditorPageContent />
    </Suspense>
  );
}
