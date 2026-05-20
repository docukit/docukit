"use client";

import { useState } from "react";
import { createDocId } from "../utils/docId";
import { EditorExample } from "./EditorExample";

export function HomeSyncedEditorsDemo() {
  const [docId, setDocId] = useState(createDocId);

  return (
    <section className="mx-auto max-w-7xl px-2 py-12 md:py-16">
      <div className="mb-10 text-center md:mb-14">
        <h2 className="mb-4 text-3xl font-bold tracking-tight text-slate-100 md:text-4xl">
          See it in action
        </h2>
        <p className="mx-auto max-w-2xl text-slate-400 md:text-lg">
          Built with{" "}
          <code className="rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-sm">
            docnode-lexical
          </code>{" "}
          and{" "}
          <code className="rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-sm">
            docsync-react
          </code>
          .
        </p>
        <p className="mx-auto max-w-2xl text-slate-400 md:text-lg">
          Type in any editor, disconnect clients, or switch the document ID.
        </p>
      </div>
      <EditorExample docId={docId} onDocIdChange={setDocId} />
    </section>
  );
}
