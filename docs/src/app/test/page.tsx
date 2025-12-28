"use client";
import { useEffect, useLayoutEffect, useState } from "react";
import { createIndexNode, useDoc } from "./ClientLayout";
import { IndexDoc } from "./IndexDoc";

function SubPage({ id }: { id: string }) {
  const result = useDoc({
    type: "indexDoc",
    id: "01kcfhzz66v3393xhggx6aeb6t",
    createIfMissing: true,
  });
  const indexDoc = result.status === "success" ? result.data.doc : undefined;
  const [activeDoc, setActiveDoc] = useState<string | undefined>();

  useLayoutEffect(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  }, []);

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
