"use client";
import { useEffect, useLayoutEffect, useState } from "react";
import { createIndexNode } from "./ClientLayout";
import { IndexDoc } from "./IndexDoc";
import { useDoc } from "@docnode/sync-react";

function SubPage({ id }: { id: string }) {
  const indexDoc = useDoc({
    namespace: "indexDoc",
    id: "01KCFHZZ66V3393XHGGX6AEB6T",
  });
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

  if (!indexDoc) return <div>Loading...</div>;
  return (
    <div className="flex" id={id}>
      <div className="main-doc">
        <IndexDoc
          activeDoc={indexDoc.root.id}
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
