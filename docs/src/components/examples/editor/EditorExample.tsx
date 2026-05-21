"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";
import type { Presence } from "@docukit/docnode-lexical/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Italic,
  Redo2,
  Underline,
  Undo2,
} from "lucide-react";
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

function EditorSkeletonDivider() {
  return <div className="bg-fd-border mx-0.5 h-5 w-px shrink-0" />;
}

function EditorSkeletonToolbarButton({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
    >
      {children}
    </button>
  );
}

function EditorSkeletonToolbar() {
  return (
    <div
      aria-hidden="true"
      className="border-fd-border bg-fd-secondary flex h-10 flex-nowrap items-center gap-0.5 overflow-x-auto border-b px-1.5 py-1"
    >
      <EditorSkeletonToolbarButton>
        <Undo2 size={16} />
      </EditorSkeletonToolbarButton>
      <EditorSkeletonToolbarButton>
        <Redo2 size={16} />
      </EditorSkeletonToolbarButton>

      <EditorSkeletonDivider />

      <EditorSkeletonToolbarButton>
        <Heading1 size={16} />
      </EditorSkeletonToolbarButton>

      <EditorSkeletonDivider />

      <EditorSkeletonToolbarButton>
        <Bold size={16} />
      </EditorSkeletonToolbarButton>
      <EditorSkeletonToolbarButton>
        <Italic size={16} />
      </EditorSkeletonToolbarButton>
      <EditorSkeletonToolbarButton>
        <Underline size={16} />
      </EditorSkeletonToolbarButton>

      <EditorSkeletonDivider />

      <EditorSkeletonToolbarButton>
        <AlignLeft size={16} />
      </EditorSkeletonToolbarButton>
      <EditorSkeletonToolbarButton>
        <AlignCenter size={16} />
      </EditorSkeletonToolbarButton>
      <EditorSkeletonToolbarButton>
        <AlignRight size={16} />
      </EditorSkeletonToolbarButton>
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div
      className="border-fd-border bg-fd-background overflow-hidden rounded-lg border shadow-sm"
      aria-label="Loading editor"
    >
      <EditorSkeletonToolbar />
      <div className="min-h-100 px-6 py-4">
        <div className="bg-fd-muted mb-3 h-4 w-24 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted mb-3 h-4 w-11/12 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted mb-3 h-4 w-4/5 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted h-4 w-2/3 animate-pulse rounded [animation-duration:1s]" />
      </div>
    </div>
  );
}

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
    <div className="mx-auto mb-4 flex max-w-3xl flex-col items-center justify-center gap-2 px-4 md:flex-row">
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
        className="border-fd-border bg-fd-background text-fd-foreground focus:border-fd-primary aria-invalid:border-destructive h-8 w-full max-w-[32ch] rounded-md border px-2.5 font-mono text-sm transition outline-none md:w-[32ch]"
      />
      <button
        type="button"
        data-testid="new-doc-button"
        onClick={createNewDoc}
        className="border-fd-border text-fd-foreground hover:bg-fd-accent hover:text-fd-accent-foreground h-8 rounded-md border px-3 text-sm font-medium transition"
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
    return <EditorSkeleton />;
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
