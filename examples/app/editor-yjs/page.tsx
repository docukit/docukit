"use client";

import { useRef, Suspense } from "react";
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
import * as Y from "yjs";

/** Pre-populate the Y.Doc's root XmlText with initial paragraphs for Lexical.
 * Lexical's Yjs binding stores each paragraph as an embedded Y.XmlText within
 * the root XmlText. Text nodes are a Y.Map (properties) + raw text. */
function initializeEditorDoc(doc: Y.Doc) {
  const root = doc.get("root", Y.XmlText);
  if (root.length > 0) return; // Already has content

  doc.transact(() => {
    for (const text of ["One", "Two", "Three"]) {
      const p = new Y.XmlText();
      root.insertEmbed(root.length, p);
      p.setAttribute("__type", "paragraph");
      // Text node: Y.Map with type info, then raw text
      const textMap = new Y.Map();
      textMap.set("__type", "text");
      p.insertEmbed(0, textMap);
      p.insert(1, text);
    }
  });
}

function EditorContent({
  clientId,
  docId,
  useDocHook,
}: {
  clientId: string;
  docId: string;
  useDocHook: typeof useReferenceDoc;
}) {
  const { status, data, error } = useDocHook({
    type: "yjs-editor",
    id: docId,
    createIfMissing: true,
  });

  const initialized = useRef(false);

  if (status === "error")
    return <div className="text-red-400">Error: {error.message}</div>;

  if (status === "loading")
    return <div className="text-zinc-400">Connecting...</div>;

  const { doc } = data as { doc: Y.Doc };

  // Only the reference client initializes the Y.Doc with content.
  // Other clients receive the content via server sync.
  if (clientId === "reference" && !initialized.current) {
    initialized.current = true;
    initializeEditorDoc(doc);
  }

  return <EditorPanel doc={doc} docId={docId} />;
}

function EditorPageContent() {
  const docId = useDocId("/editor-yjs");

  if (!docId) {
    return null;
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-zinc-950 via-zinc-900 to-zinc-950 p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Lexical Editor (Yjs) - Multi-Client Sync
      </h1>

      <MultiClientLayout
        referenceClient={referenceClient!}
        otherTabClient={otherTabClient!}
        otherDeviceClient={otherDeviceClient!}
      >
        {(clientId) => {
          if (clientId === "reference") {
            return (
              <EditorContent
                clientId={clientId}
                docId={docId}
                useDocHook={useReferenceDoc}
              />
            );
          }

          if (clientId === "otherTab") {
            return (
              <EditorContent
                clientId={clientId}
                docId={docId}
                useDocHook={useOtherTabDoc}
              />
            );
          }

          return (
            <EditorContent
              clientId={clientId}
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
