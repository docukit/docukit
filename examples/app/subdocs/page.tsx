"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createIndexNode, useDoc } from "./ClientLayout";
import { IndexDoc } from "./IndexDoc";

function SubPage({ id }: { id: string }) {
  // Get docId from URL param
  const searchParams = useSearchParams();
  const docId = searchParams.get("docId") ?? "01kcfhzz66v3393xhggx6aeb6t";

  const result = useDoc({
    type: "indexDoc",
    id: docId,
    createIfMissing: true,
  });
  const indexDoc = result.status === "success" ? result.data.doc : undefined;
  const [activeDoc, setActiveDoc] = useState<string | undefined>();

  useEffect(() => {
    if (!indexDoc) return;
    if (indexDoc.root.first) return;
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
  }, [indexDoc]);

  if (result.status === "error")
    return <div>Error: {result.error.message}</div>;
  if (result.status === "loading") return <div>Loading...</div>;

  return (
    <div className="flex" id={id}>
      <div className="main-doc">
        <IndexDoc
          activeDoc={result.data.id}
          selectedDoc={activeDoc}
          setActiveDoc={setActiveDoc}
        />
      </div>
      <div className="m-2 h-96 border-l-2 border-gray-300" />
      {activeDoc ? (
        <div className="secondary-doc">
          <IndexDoc activeDoc={activeDoc} />
        </div>
      ) : (
        <p>Select a document</p>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <>
      <SubPage id="original" />
      <SubPage id="copy" />
    </>
  );
}
