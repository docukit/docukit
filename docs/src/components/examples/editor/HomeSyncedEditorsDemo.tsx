"use client";

import { useState } from "react";
import { createDocId } from "../utils/docId";
import { EditorExample } from "./EditorExample";

export function HomeSyncedEditorsDemo() {
  const [docId, setDocId] = useState(createDocId);

  return (
    <section className="mx-auto max-w-7xl px-2 py-12 md:py-16">
      <div className="mb-10 text-center md:mb-14">
        <h2 className="text-fd-foreground mb-4 text-3xl font-bold tracking-tight md:text-4xl">
          See it in action
        </h2>
        <p className="text-fd-muted-foreground mx-auto max-w-2xl md:text-lg">
          Built with{" "}
          <code className="bg-fd-secondary text-fd-foreground rounded px-1.5 py-0.5 font-mono text-sm">
            docnode-lexical
          </code>{" "}
          and{" "}
          <code className="bg-fd-secondary text-fd-foreground rounded px-1.5 py-0.5 font-mono text-sm">
            docsync-react
          </code>
          .
        </p>
        <p className="text-fd-muted-foreground mx-auto max-w-2xl md:text-lg">
          Type in any editor, disconnect clients, or switch the document ID.
        </p>
      </div>
      <EditorExample docId={docId} onDocIdChange={setDocId} />
    </section>
  );
}
