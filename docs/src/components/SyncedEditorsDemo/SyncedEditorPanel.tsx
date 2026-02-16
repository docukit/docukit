"use client";

import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
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
import { ToolbarPlugin } from "./ToolbarPlugin";

export function SyncedEditorPanel({
  doc,
  presence,
  setPresence,
  user,
  isPrimary,
  label,
}: {
  doc: Doc;
  presence?: Presence;
  setPresence?: (selection: unknown) => void;
  user?: PresenceUser;
  isPrimary?: boolean;
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {label ? (
        <div className="text-sm font-medium text-slate-400">{label}</div>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-slate-600/40 bg-slate-900/60 shadow-xl backdrop-blur-sm">
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
          <ToolbarPlugin />
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable className="min-h-55 bg-slate-800/80 px-5 py-4 text-slate-300 outline-none focus:outline-none" />
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

      const heading = $createHeadingNode("h1");
      heading.append($createTextNode("This is a Lexical editor."));

      const p1 = $createParagraphNode();
      const syncIntro = $createTextNode(
        "It stays collaborative and in sync thanks to ",
      );
      const docNode = $createTextNode("DocNode");
      docNode.setFormat("bold");
      const and = $createTextNode(" and ");
      const docSync = $createTextNode("DocSync");
      docSync.setFormat("bold");
      const syncOutro = $createTextNode(
        ": type here or in the other panel — changes flow in real time.",
      );
      p1.append(syncIntro, docNode, and, docSync, syncOutro);

      const p2 = $createParagraphNode();
      const pitchStart = $createTextNode(
        "DocNode gives you type-safe documents and conflict-free merges. ",
      );
      const pitchSync = $createTextNode("DocSync");
      pitchSync.setFormat("bold");
      const pitchEnd = $createTextNode(
        " keeps every client in sync over the wire—no custom server logic required.",
      );
      p2.append(pitchStart, pitchSync, pitchEnd);

      root.append(heading, p1, p2);
    });
  }, [editor]);

  return null;
}
