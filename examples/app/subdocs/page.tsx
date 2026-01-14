"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  createIndexNode,
  useReferenceDoc,
  useOtherTabDoc,
  useOtherDeviceDoc,
} from "./ClientProviders";
import { IndexDoc } from "./IndexDoc";
import { MultiClientLayout } from "./MultiClientLayout";

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
  const result = useDocHook({
    type: "indexDoc",
    id: docId,
    createIfMissing: true,
  });

  const indexDoc = result.status === "success" ? result.data?.doc : undefined;
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
  }, [indexDoc, clientId]);

  if (result.status === "error")
    return <div className="text-red-400">Error: {result.error.message}</div>;

  // Show loading state
  if (result.status === "loading")
    return <div className="text-zinc-400">Connecting...</div>;

  // Document doesn't exist yet (waiting for reference to create it)
  if (!result.data)
    return <div className="text-zinc-400">Waiting for document...</div>;

  if (!indexDoc)
    return <div className="text-zinc-400">Loading document...</div>;

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

export default function Page() {
  const searchParams = useSearchParams();
  const docId = searchParams.get("docId") ?? "01kcfhzz66v3393xhggx6aeb6t";

  return (
    <div className="p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Subdocs Example - Multi-Client Sync
      </h1>

      <MultiClientLayout>
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
