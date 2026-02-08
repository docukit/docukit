"use client";

import { HeadingNode } from "@lexical/rich-text";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import {
  DocNodePlugin,
  type Presence,
  type PresenceUser,
} from "@docukit/docnode-lexical/react";
import type { Doc } from "@docukit/docnode";
import { useEffect } from "react";

type SyncedEditorPanelProps = {
  doc: Doc;
  presence?: Presence;
  setPresence?: (selection: unknown) => void;
  user?: PresenceUser;
  isPrimary?: boolean;
  label: string;
};

export function SyncedEditorPanel({
  doc,
  presence,
  setPresence,
  user,
  isPrimary,
  label,
}: SyncedEditorPanelProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-slate-400">{label}</div>
      <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900/50 shadow-xl">
        <LexicalComposer
          initialConfig={{
            namespace: "SyncedEditorsDemo",
            nodes: [HeadingNode],
            theme: {
              paragraph: "mb-2 text-slate-200 leading-relaxed",
              heading: {
                h1: "text-2xl font-bold text-white mb-3 mt-2",
                h2: "text-xl font-semibold text-slate-100 mb-2 mt-2",
                h3: "text-lg font-medium text-slate-200 mb-2 mt-2",
              },
              text: {
                bold: "font-bold",
                italic: "italic",
                underline: "underline",
                strikethrough: "line-through",
              },
            },
            onError: (error: Error) => {
              console.error(error);
            },
          }}
        >
          <DocNodePlugin
            doc={doc}
            presence={presence}
            setPresence={setPresence}
            user={user}
          />
          {isPrimary ? <InitialContentPlugin /> : null}
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable className="min-h-[200px] px-4 py-3 text-slate-300 outline-none focus:outline-none" />
              }
              ErrorBoundary={LexicalErrorBoundary}
              placeholder={
                <div className="pointer-events-none absolute top-3 left-4 text-slate-500">
                  Type here… changes sync to the other editor.
                </div>
              }
            />
          </div>
          <HistoryPlugin />
        </LexicalComposer>
      </div>
    </div>
  );
}

function InitialContentPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor) return;
    editor.update(() => {
      const root = $getRoot();
      if (root.getChildrenSize() !== 0) return;
      const p1 = $createParagraphNode();
      const p2 = $createParagraphNode();
      const text1 = $createTextNode("Edit this text. ");
      const text2 = $createTextNode("Both editors stay in sync.");
      p1.append(text1);
      p2.append(text2);
      root.append(p1, p2);
    });
  }, [editor]);

  return null;
}
