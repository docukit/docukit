"use client";

import { Suspense } from "react";
import { SubdocsExample } from "@/components/examples/subdocs/SubdocsExample";
import { useDocId } from "@/components/examples/utils/useDocId";

function SubdocsPageContent() {
  const docId = useDocId("/examples/subdocs");

  if (!docId) return null;

  return (
    <main className="px-4 py-6 md:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Subdocs Example
      </h1>
      <SubdocsExample docId={docId} />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={<div className="text-fd-muted-foreground p-4">Loading...</div>}
    >
      <SubdocsPageContent />
    </Suspense>
  );
}
