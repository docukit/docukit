"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { createIndexNode, indexDocConfig } from "../shared-config";
import { createMultiClients } from "../utils/createMultiClients";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { IndexDoc } from "./IndexDoc";

const clients = createMultiClients([indexDocConfig]);

type SeedSkeletonNode = {
  children?: readonly SeedSkeletonNode[];
  value: string;
};

const seedSkeletonNodes: readonly SeedSkeletonNode[] = [
  {
    value: "root",
    children: [
      { value: "1" },
      { value: "2", children: [{ value: "2.1" }, { value: "2.2" }] },
      { value: "3" },
      { value: "4" },
    ],
  },
];

function SubdocsLoadingNode({
  isRoot = false,
  node,
}: {
  isRoot?: boolean;
  node: SeedSkeletonNode;
}) {
  return (
    <div className="relative" style={{ paddingLeft: isRoot ? "0px" : "20px" }}>
      <div className="docnode flex items-center rounded px-2 py-0.5">
        <span className="text-fd-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {node.value}
          <span className="node-id ml-1 inline-flex h-[1em] w-[4ch] items-center align-middle">
            <span className="bg-fd-muted block h-[0.75em] w-full animate-pulse rounded [animation-duration:1s]" />
          </span>
        </span>
        <div className="ml-2 flex shrink-0 flex-row items-center gap-0.5">
          <span className="inline-flex h-5 w-[1.375rem] rounded" />
          <span className="inline-flex h-5 w-[1.375rem] rounded" />
        </div>
      </div>
      {node.children && (
        <div className="mt-0.5">
          {node.children.map((child) => (
            <SubdocsLoadingNode key={child.value} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubdocsLoadingTree() {
  return (
    <div className="docnode-doc text-sm">
      {seedSkeletonNodes.map((node) => (
        <SubdocsLoadingNode key={node.value} isRoot node={node} />
      ))}
    </div>
  );
}

function SubdocsLoadingPanel() {
  return (
    <div className="flex min-h-40 gap-3">
      <div className="main-doc flex-1">
        <SubdocsLoadingTree />
      </div>
      <div className="bg-fd-border w-px" />
      <div className="flex flex-1 items-start justify-center pt-8">
        <p className="text-fd-muted-foreground text-xs">Select a document</p>
      </div>
    </div>
  );
}

function SubdocsSkeletonOverlay() {
  return (
    <div
      className="docs-subdocs-skeleton-overlay bg-fd-card pointer-events-none absolute inset-0 z-10"
      aria-hidden="true"
    >
      <SubdocsLoadingPanel />
    </div>
  );
}

function SubdocsPanelFrame({
  children,
  isLoading,
}: {
  children: React.ReactNode;
  isLoading?: boolean;
}) {
  return (
    <div
      className="relative min-h-40 overflow-hidden"
      data-subdocs-loading={isLoading ? "true" : undefined}
    >
      {children}
      <SubdocsSkeletonOverlay />
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

  const isReady = status === "success" && data.docId === docId;

  return (
    <SubdocsPanelFrame isLoading={!isReady}>
      {isReady ? (
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
              <p className="text-fd-muted-foreground text-xs">
                Select a document
              </p>
            </div>
          )}
        </div>
      ) : (
        <SubdocsLoadingPanel />
      )}
    </SubdocsPanelFrame>
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
      {() => (
        <SubdocsPanelFrame isLoading>
          <SubdocsLoadingPanel />
        </SubdocsPanelFrame>
      )}
    </MultiClientLayout>
  );
}
