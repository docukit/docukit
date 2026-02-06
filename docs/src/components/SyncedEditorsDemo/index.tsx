"use client";

import { useMemo } from "react";
import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";
import { createTwoClients } from "@/lib/synced-editors-demo/createTwoClients";
import { SyncedEditorPanel } from "./SyncedEditorPanel";
import type { Presence } from "@docukit/docnode-lexical";

// Fixed doc id for the home demo (must be a valid lowercase ULID per DocNode)
const DEMO_DOC_ID = "01j8d0cs0h0me0dem000000001";

const USER_COLORS: Record<string, string> = {
  user1: "#3b82f6",
  user2: "#22c55e",
};

type TwoClients = ReturnType<typeof createTwoClients>;

function EditorSlot({
  label,
  isPrimary,
  useDoc,
  usePresence,
  userId,
}: {
  label: string;
  isPrimary: boolean;
  useDoc: TwoClients["useEditor1Doc"];
  usePresence: TwoClients["useEditor1Presence"];
  userId: string;
}) {
  const { status, data, error } = useDoc({
    type: "docnode-lexical",
    id: DEMO_DOC_ID,
    createIfMissing: true,
  });
  const [presence, setPresence] = usePresence({ docId: DEMO_DOC_ID });

  if (status === "error") {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
        Could not connect. Start the examples server to try the demo:{" "}
        <code className="mt-1 block font-mono text-xs">pnpm dev:examples</code>
        <span className="mt-2 block text-red-400">{error?.message}</span>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-xl border border-slate-700/50 bg-slate-900/50 text-slate-500">
        Connecting…
      </div>
    );
  }

  const { doc } = data!;
  return (
    <SyncedEditorPanel
      doc={doc}
      label={label}
      isPrimary={isPrimary}
      presence={presence as Presence}
      setPresence={setPresence}
      user={{
        name: userId,
        color: USER_COLORS[userId] ?? "#888",
      }}
    />
  );
}

export function SyncedEditorsDemo() {
  const clients = useMemo(() => createTwoClients([lexicalDocNodeConfig]), []);

  return (
    <section className="mx-auto max-w-5xl">
      <h2 className="mb-2 text-2xl font-bold text-slate-100">
        Two editors, one document
      </h2>
      <p className="mb-6 text-slate-400">
        Built with{" "}
        <code className="rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-sm">
          docnode-lexical
        </code>{" "}
        and{" "}
        <code className="rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-sm">
          docsync-react
        </code>
        . Type in either editor — changes sync in real time. Run the examples
        server to try it live.
      </p>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <EditorSlot
          label="Editor 1"
          isPrimary
          useDoc={clients.useEditor1Doc}
          usePresence={clients.useEditor1Presence}
          userId="user1"
        />
        <EditorSlot
          label="Editor 2"
          isPrimary={false}
          useDoc={clients.useEditor2Doc}
          usePresence={clients.useEditor2Presence}
          userId="user2"
        />
      </div>
    </section>
  );
}
