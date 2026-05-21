"use client";

import { useEffect, useState } from "react";
import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";
import type { Presence } from "@docukit/docnode-lexical/react";
import { cn } from "@/lib/cn";
import { createMultiClients } from "../utils/createMultiClients";
import { createDocId, isValidDocId } from "../utils/docId";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { EditorPanel } from "./EditorPanel";

const USER_COLORS: Record<string, string> = {
  user1: "#3b82f6",
  user2: "#22c55e",
};

const clients = createMultiClients([lexicalDocNodeConfig]);

function DocIdControl({
  docId,
  onDocIdChange,
}: {
  docId: string;
  onDocIdChange: (docId: string) => void;
}) {
  const [draftDocId, setDraftDocId] = useState(docId);
  const draftIsValid = isValidDocId(draftDocId);

  useEffect(() => {
    setDraftDocId(docId);
  }, [docId]);

  function updateDraft(value: string) {
    const nextDocId = value.trim().toLowerCase();
    setDraftDocId(nextDocId);
    if (isValidDocId(nextDocId)) onDocIdChange(nextDocId);
  }

  function createNewDoc() {
    const nextDocId = createDocId();
    setDraftDocId(nextDocId);
    onDocIdChange(nextDocId);
  }

  return (
    <div className="mx-auto mb-4 flex max-w-3xl flex-col gap-2 px-4 md:flex-row md:items-center">
      <label
        htmlFor="docsync-demo-doc-id"
        className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase"
      >
        Doc ID
      </label>
      <input
        id="docsync-demo-doc-id"
        data-testid="doc-id-input"
        value={draftDocId}
        onChange={(event) => updateDraft(event.target.value)}
        aria-invalid={!draftIsValid}
        className="border-fd-border bg-fd-background text-fd-foreground focus:border-fd-primary aria-invalid:border-destructive h-9 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm transition outline-none"
      />
      <button
        type="button"
        data-testid="new-doc-button"
        onClick={createNewDoc}
        className="border-fd-border text-fd-foreground hover:bg-fd-accent hover:text-fd-accent-foreground h-9 rounded-md border px-3 text-sm font-medium transition"
      >
        New
      </button>
      {!draftIsValid && (
        <p className="text-destructive text-xs md:w-38">
          Use a lowercase ULID.
        </p>
      )}
    </div>
  );
}

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
  useDocHook: typeof clients.useReferenceDoc;
  usePresenceHook: typeof clients.useReferencePresence;
}) {
  const { status, data, error } = useDocHook({
    type: "docnode-lexical",
    id: docId,
    createIfMissing: true,
  });
  const [presence, setPresence] = usePresenceHook({ docId });

  if (status === "error") {
    return <div className="text-destructive">Error: {error.message}</div>;
  }

  if (status === "loading") {
    return <div className="text-fd-muted-foreground">Connecting...</div>;
  }

  return (
    <EditorPanel
      key={`${clientId}:${docId}`}
      doc={data.doc}
      clientId={clientId}
      presence={presence as Presence}
      setPresence={setPresence}
      user={{ name: userId, color: USER_COLORS[userId] ?? "#888888" }}
    />
  );
}

export function EditorExample({
  docId,
  onDocIdChange,
  className,
}: {
  docId: string;
  onDocIdChange?: (docId: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("w-full", className)}>
      {onDocIdChange && (
        <DocIdControl docId={docId} onDocIdChange={onDocIdChange} />
      )}
      <MultiClientLayout
        referenceClient={clients.referenceClient}
        otherTabClient={clients.otherTabClient}
        otherDeviceClient={clients.otherDeviceClient}
      >
        {(clientId, userId) => {
          if (clientId === "reference") {
            return (
              <EditorContent
                clientId={clientId}
                userId={userId}
                docId={docId}
                useDocHook={clients.useReferenceDoc}
                usePresenceHook={clients.useReferencePresence}
              />
            );
          }

          if (clientId === "otherTab") {
            return (
              <EditorContent
                clientId={clientId}
                userId={userId}
                docId={docId}
                useDocHook={clients.useOtherTabDoc}
                usePresenceHook={clients.useOtherTabPresence}
              />
            );
          }

          return (
            <EditorContent
              clientId={clientId}
              userId={userId}
              docId={docId}
              useDocHook={clients.useOtherDeviceDoc}
              usePresenceHook={clients.useOtherDevicePresence}
            />
          );
        }}
      </MultiClientLayout>
    </div>
  );
}
