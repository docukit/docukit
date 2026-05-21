"use client";

import type React from "react";
import { Suspense } from "react";
import {
  SubdocsExample,
  SubdocsExampleLoading,
} from "@/components/examples/subdocs/SubdocsExample";
import { useDocId } from "@/components/examples/utils/useDocId";

function SubdocsPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="px-4 py-6 md:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Subdocs Example
      </h1>
      {children}
    </main>
  );
}

function SubdocsPageContent() {
  const docId = useDocId("/examples/subdocs");

  if (!docId) {
    return (
      <SubdocsPageShell>
        <SubdocsExampleLoading />
      </SubdocsPageShell>
    );
  }

  return (
    <SubdocsPageShell>
      <SubdocsExample docId={docId} />
    </SubdocsPageShell>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <SubdocsPageShell>
          <SubdocsExampleLoading />
        </SubdocsPageShell>
      }
    >
      <SubdocsPageContent />
    </Suspense>
  );
}
