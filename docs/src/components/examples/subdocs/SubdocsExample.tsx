"use client";

import { useEffect, useState } from "react";
import { createIndexNode, indexDocConfig } from "../shared-config";
import { createMultiClients } from "../utils/createMultiClients";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { IndexDoc } from "./IndexDoc";

const clients = createMultiClients([indexDocConfig]);

function SubdocsLoadingPanel() {
  return (
    <div className="flex min-h-40 gap-3">
      <div className="flex-1 space-y-2">
        <div className="bg-fd-muted h-4 w-20 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted h-4 w-28 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted ml-4 h-4 w-24 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted ml-4 h-4 w-22 animate-pulse rounded [animation-duration:1s]" />
        <div className="bg-fd-muted h-4 w-26 animate-pulse rounded [animation-duration:1s]" />
      </div>
      <div className="bg-fd-border w-px" />
      <div className="flex flex-1 items-start justify-center pt-8">
        <div className="bg-fd-muted h-3 w-28 animate-pulse rounded [animation-duration:1s]" />
      </div>
    </div>
  );
}

function SubDocContent({
  clientId,
  docId,
  useDocHook,
}: {
  clientId: string;
  docId: string;
  useDocHook: typeof clients.useReferenceDoc;
}) {
  const { status, data, error } = useDocHook({
    type: "indexDoc",
    id: docId,
    createIfMissing: true,
  });
  const [activeDoc, setActiveDoc] = useState<string | undefined>();

  useEffect(() => {
    setActiveDoc(undefined);
  }, [docId]);

  const secondaryDocId = activeDoc ?? docId;
  const secondaryResult = useDocHook({
    type: "indexDoc",
    id: secondaryDocId,
    createIfMissing: true,
  });
  const secondaryDoc =
    activeDoc && secondaryResult.status === "success"
      ? secondaryResult.data.doc
      : undefined;

  useEffect(() => {
    if (clientId !== "reference") return;
    const indexDoc = data?.doc;
    if (!indexDoc || indexDoc.root.first) return;

    const one = createIndexNode(indexDoc, { value: "1" });
    const two = createIndexNode(indexDoc, { value: "2" });
    const three = createIndexNode(indexDoc, { value: "3" });
    const four = createIndexNode(indexDoc, { value: "4" });

    indexDoc.root.append(one, two, three, four);
    two.append(
      createIndexNode(indexDoc, { value: "2.1" }),
      createIndexNode(indexDoc, { value: "2.2" }),
    );
  }, [data, clientId]);

  if (status === "error") {
    return <div className="text-destructive">Error: {error.message}</div>;
  }

  if (status === "loading" || data.docId !== docId) {
    return <SubdocsLoadingPanel />;
  }

  return (
    <div className="flex gap-3" id={clientId} key={`${clientId}:${docId}`}>
      <div className="main-doc flex-1">
        <IndexDoc
          doc={data.doc}
          selectedDoc={activeDoc}
          setActiveDoc={setActiveDoc}
        />
      </div>
      <div className="bg-fd-border w-px" />
      {activeDoc && secondaryDoc ? (
        <div className="secondary-doc flex-1">
          <IndexDoc doc={secondaryDoc} />
        </div>
      ) : (
        <div className="flex flex-1 items-start justify-center pt-8">
          <p className="text-fd-muted-foreground text-xs">Select a document</p>
        </div>
      )}
    </div>
  );
}

export function SubdocsExample({ docId }: { docId: string }) {
  return (
    <MultiClientLayout
      referenceClient={clients.referenceClient}
      otherTabClient={clients.otherTabClient}
      otherDeviceClient={clients.otherDeviceClient}
    >
      {(clientId) => {
        if (clientId === "reference") {
          return (
            <SubDocContent
              clientId={clientId}
              docId={docId}
              useDocHook={clients.useReferenceDoc}
            />
          );
        }

        if (clientId === "otherTab") {
          return (
            <SubDocContent
              clientId={clientId}
              docId={docId}
              useDocHook={clients.useOtherTabDoc}
            />
          );
        }

        return (
          <SubDocContent
            clientId={clientId}
            docId={docId}
            useDocHook={clients.useOtherDeviceDoc}
          />
        );
      }}
    </MultiClientLayout>
  );
}

export function SubdocsExampleLoading() {
  return (
    <MultiClientLayout
      referenceClient={clients.referenceClient}
      otherTabClient={clients.otherTabClient}
      otherDeviceClient={clients.otherDeviceClient}
    >
      {() => <SubdocsLoadingPanel />}
    </MultiClientLayout>
  );
}
