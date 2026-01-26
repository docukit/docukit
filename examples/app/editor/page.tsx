"use client";

import { useEffect, Suspense } from "react";
import {
  useReferenceDoc,
  useOtherTabDoc,
  useOtherDeviceDoc,
  referenceClient,
  otherTabClient,
  otherDeviceClient,
} from "./ClientProviders";
import { EditorPanel } from "./EditorPanel";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { useDocId } from "../utils/useDocId";

function EditorContent({
  clientId,
  docId,
  useDocHook,
}: {
  clientId: string;
  userId: string;
  docId: string;
  useDocHook: typeof useReferenceDoc;
}) {
  // All clients create doc if missing (safe with CRDT)
  const { status, data, error } = useDocHook({
    type: "docnode-lexical",
    id: docId,
    createIfMissing: true,
  });

  useEffect(() => {
    // Only initialize from reference client
    if (clientId !== "reference") return;
    if (!data?.doc.root.first) return;

    // Initialize doc with default content
    // The docToLexical binding will handle Lexical initialization
  }, [data, clientId]);

  if (status === "error")
    return <div className="text-red-400">Error: {error.message}</div>;

  // Show loading state
  if (status === "loading")
    return <div className="text-zinc-400">Connecting...</div>;

  const { doc } = data;

  return <EditorPanel doc={doc} clientId={clientId} />;
}

function EditorPageContent() {
  const docId = useDocId("/editor");

  // Show loading while redirecting (prevents rendering with undefined docId)
  if (!docId) {
    return null; // Return null instead of loading to avoid mounting/unmounting
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-zinc-950 via-zinc-900 to-zinc-950 p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Lexical Editor Example - Multi-Client Sync
      </h1>

      <MultiClientLayout
        referenceClient={referenceClient!}
        otherTabClient={otherTabClient!}
        otherDeviceClient={otherDeviceClient!}
      >
        {(clientId, userId) => {
          // Each client gets its own independent provider
          if (clientId === "reference") {
            return (
              <EditorContent
                clientId={clientId}
                userId={userId}
                docId={docId}
                useDocHook={useReferenceDoc}
              />
            );
          }

          if (clientId === "otherTab") {
            return (
              <EditorContent
                clientId={clientId}
                userId={userId}
                docId={docId}
                useDocHook={useOtherTabDoc}
              />
            );
          }

          // otherDevice
          return (
            <EditorContent
              clientId={clientId}
              userId={userId}
              docId={docId}
              useDocHook={useOtherDeviceDoc}
            />
          );
        }}
      </MultiClientLayout>
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
