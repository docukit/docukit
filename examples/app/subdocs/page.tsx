"use client";
import { useEffect, useState, Suspense } from "react";
import {
  createIndexNode,
  useReferenceDoc,
  useOtherTabDoc,
  useOtherDeviceDoc,
  referenceClient,
  otherTabClient,
  otherDeviceClient,
} from "./ClientProviders";
import { IndexDoc } from "./IndexDoc";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { useDocId } from "../utils/useDocId";

function SubDocContent({
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
    type: "indexDoc",
    id: docId,
    createIfMissing: true,
  });

  const [activeDoc, setActiveDoc] = useState<string | undefined>();

  // Load secondary doc when selected
  const secondaryDocId = activeDoc ?? docId;
  const secondaryResult = useDocHook({
    type: "indexDoc",
    id: secondaryDocId,
    createIfMissing: true,
  });
  const secondaryDoc =
    activeDoc && secondaryResult.status === "success"
      ? secondaryResult.data?.doc
      : undefined;

  useEffect(() => {
    // Only initialize from reference client
    if (clientId !== "reference") return;
    const indexDoc = data?.doc;
    if (!indexDoc || indexDoc.root.first) return;

    // Initialize doc with default nodes
    indexDoc.root.append(
      createIndexNode(indexDoc, { value: "1" }),
      createIndexNode(indexDoc, { value: "2" }),
      createIndexNode(indexDoc, { value: "3" }),
      createIndexNode(indexDoc, { value: "4" }),
    );
    const two = indexDoc.root.first!.next!;
    two.append(
      createIndexNode(indexDoc, { value: "2.1" }),
      createIndexNode(indexDoc, { value: "2.2" }),
    );
  }, [data, clientId]);

  if (status === "error")
    return <div className="text-red-400">Error: {error.message}</div>;

  // Show loading state
  if (status === "loading")
    return <div className="text-zinc-400">Connecting...</div>;

  const { doc: indexDoc } = data;

  return (
    <div className="flex gap-3" id={clientId}>
      <div className="main-doc flex-1">
        <IndexDoc
          doc={indexDoc}
          selectedDoc={activeDoc}
          setActiveDoc={setActiveDoc}
        />
      </div>
      <div className="w-px bg-zinc-800" />
      {activeDoc && secondaryDoc ? (
        <div className="secondary-doc flex-1">
          <IndexDoc doc={secondaryDoc} />
        </div>
      ) : (
        <div className="flex flex-1 items-start justify-center pt-8">
          <p className="text-xs text-zinc-500">Select a document</p>
        </div>
      )}
    </div>
  );
}

function SubdocsPageContent() {
  const docId = useDocId("/subdocs");

  // Show loading while redirecting (prevents rendering with undefined docId)
  if (!docId) {
    return null; // Return null instead of loading to avoid mounting/unmounting
  }

  return (
    <div className="p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Subdocs Example - Multi-Client Sync
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
              <SubDocContent
                clientId={clientId}
                userId={userId}
                docId={docId}
                useDocHook={useReferenceDoc}
              />
            );
          }

          if (clientId === "otherTab") {
            return (
              <SubDocContent
                clientId={clientId}
                userId={userId}
                docId={docId}
                useDocHook={useOtherTabDoc}
              />
            );
          }

          // otherDevice
          return (
            <SubDocContent
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
      <SubdocsPageContent />
    </Suspense>
  );
}
