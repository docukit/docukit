"use client";

import { Suspense } from "react";
import { SubdocsExample } from "@/components/examples/subdocs/SubdocsExample";
import { useDocId } from "@/components/examples/utils/useDocId";

function SubdocsPageContent() {
  const docId = useDocId("/examples/subdocs");

  if (!docId) return null;

  return (
    <div className="p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Subdocs Example - Multi-Client Sync
      </h1>
      <SubdocsExample docId={docId} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-4 text-zinc-400">Loading...</div>}>
      <SubdocsPageContent />
    </Suspense>
  );
}
