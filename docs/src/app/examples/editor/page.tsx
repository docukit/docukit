"use client";

import { Suspense } from "react";
import { EditorExample } from "@/components/examples/editor/EditorExample";
import { useDocId } from "@/components/examples/utils/useDocId";

function EditorPageContent() {
  const docId = useDocId("/examples/editor");

  if (!docId) return null;

  return (
    <div className="min-h-screen bg-linear-to-br from-zinc-950 via-zinc-900 to-zinc-950 p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Lexical Editor Example - Multi-Client Sync
      </h1>
      <EditorExample docId={docId} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-4 text-zinc-400">Loading...</div>}>
      <EditorPageContent />
    </Suspense>
  );
}
