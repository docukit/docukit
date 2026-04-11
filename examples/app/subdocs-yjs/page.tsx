"use client";

import { useEffect, useState, Suspense } from "react";
import {
  useReferenceDoc,
  useOtherTabDoc,
  useOtherDeviceDoc,
  referenceClient,
  otherTabClient,
  otherDeviceClient,
} from "./ClientProviders";
import { IndexDocYjs } from "./IndexDocYjs";
import { MultiClientLayout } from "../utils/MultiClientLayout";
import { useDocId } from "../utils/useDocId";
import * as Y from "yjs";

function SubDocContent({
  clientId,
  docId,
  useDocHook,
}: {
  clientId: string;
  docId: string;
  useDocHook: typeof useReferenceDoc;
}) {
  const { status, data, error } = useDocHook({
    type: "yjs-subdocs",
    id: docId,
    createIfMissing: true,
  });

  const [activeDoc, setActiveDoc] = useState<string | undefined>();

  // Load secondary doc when selected
  const secondaryDocId = activeDoc ?? docId;
  const secondaryResult = useDocHook({
    type: "yjs-subdocs",
    id: secondaryDocId,
    createIfMissing: true,
  });
  const secondaryDoc =
    activeDoc && secondaryResult.status === "success"
      ? secondaryResult.data?.doc
      : undefined;

  useEffect(() => {
    if (clientId !== "reference") return;
    const doc = data?.doc;
    if (!doc) return;
    const items = doc.getArray<Y.Map<unknown>>("items");
    if (items.length > 0) return;

    doc.transact(() => {
      const createItem = (value: string): Y.Map<unknown> => {
        const item = new Y.Map<unknown>();
        item.set("id", Math.random().toString(36).slice(2, 10));
        item.set("value", value);
        item.set("children", new Y.Array<Y.Map<unknown>>());
        return item;
      };

      const item1 = createItem("1");
      const item2 = createItem("2");
      const item3 = createItem("3");
      const item4 = createItem("4");

      // Must push items to the doc first — Yjs types must be integrated
      // into a document before their nested shared types can be read.
      items.push([item1, item2, item3, item4]);

      const children2 = item2.get("children") as Y.Array<Y.Map<unknown>>;
      children2.push([createItem("2.1"), createItem("2.2")]);
    });
  }, [data, clientId]);

  if (status === "error")
    return <div className="text-red-400">Error: {error.message}</div>;

  if (status === "loading")
    return <div className="text-zinc-400">Connecting...</div>;

  const doc = data.doc;

  return (
    <div className="flex gap-3" id={clientId}>
      <div className="main-doc flex-1">
        <IndexDocYjs
          doc={doc}
          docId={docId}
          selectedDoc={activeDoc}
          setActiveDoc={setActiveDoc}
        />
      </div>
      <div className="w-px bg-zinc-800" />
      {activeDoc && secondaryDoc ? (
        <div className="secondary-doc flex-1">
          <IndexDocYjs doc={secondaryDoc} docId={secondaryDocId} />
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
  const docId = useDocId("/subdocs-yjs");

  if (!docId) {
    return null;
  }

  return (
    <div className="p-4">
      <h1 className="mb-6 text-2xl font-bold">
        Subdocs (Yjs) - Multi-Client Sync
      </h1>

      <MultiClientLayout
        referenceClient={referenceClient!}
        otherTabClient={otherTabClient!}
        otherDeviceClient={otherDeviceClient!}
      >
        {(clientId) => {
          if (clientId === "reference") {
            return (
              <SubDocContent
                clientId={clientId}
                docId={docId}
                useDocHook={useReferenceDoc}
              />
            );
          }

          if (clientId === "otherTab") {
            return (
              <SubDocContent
                clientId={clientId}
                docId={docId}
                useDocHook={useOtherTabDoc}
              />
            );
          }

          return (
            <SubDocContent
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
      <SubdocsPageContent />
    </Suspense>
  );
}
