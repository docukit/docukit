"use client";

import { useEffect, Suspense, useCallback } from "react";
import {
  useReferenceDoc,
  useReferencePresence,
  useOtherTabDoc,
  useOtherTabPresence,
  useOtherDeviceDoc,
  useOtherDevicePresence,
  referenceClient,
  otherTabClient,
  otherDeviceClient,
} from "./ClientProviders";
import { EditorPanel } from "./EditorPanel";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { useDocId } from "../utils/useDocId";
import type { LocalSelection, Presence } from "@docnode/lexical";

// User colors for cursor display
const USER_COLORS: Record<string, string> = {
  user1: "#3b82f6", // blue
  user2: "#22c55e", // green
};

function EditorContent({
  clientId,
  userId,
  docId,
  useDocHook,
  usePresenceHook,
}: {
  clientId: string;
  userId: string;
  docId: string;
  useDocHook: typeof useReferenceDoc;
  usePresenceHook: typeof useReferencePresence;
}) {
  // All clients create doc if missing (safe with CRDT)
  const { status, data, error } = useDocHook({
    type: "docnode-lexical",
    id: docId,
    createIfMissing: true,
  });

  // Get presence for this document
  const [rawPresence, setRawPresence] = usePresenceHook({ docId });

  // Wrap setPresence to include user name and color
  const setPresence = useCallback(
    (selection: LocalSelection | undefined) => {
      if (!selection) {
        setRawPresence(undefined);
        return;
      }
      // Add name and color for remote rendering
      setRawPresence({
        ...selection,
        name: userId,
        color: USER_COLORS[userId] ?? "#888888",
      });
    },
    [setRawPresence, userId],
  );

  // Transform raw presence to typed Presence for EditorPanel
  const presence = rawPresence as Presence;

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

  return (
    <EditorPanel
      doc={doc}
      clientId={clientId}
      presence={presence}
      setPresence={setPresence}
    />
  );
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
                usePresenceHook={useReferencePresence}
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
                usePresenceHook={useOtherTabPresence}
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
              usePresenceHook={useOtherDevicePresence}
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
