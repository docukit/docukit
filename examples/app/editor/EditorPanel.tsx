"use client";

import { HeadingNode } from "@lexical/rich-text";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import ToolbarPlugin from "./ToolbarPlugin";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import type { PresenceSelection } from "@docukit/docnode-lexical";
import {
  DocNodePlugin,
  type Presence,
  type PresenceUser,
} from "@docukit/docnode-lexical/react";
import type { Doc } from "@docukit/docnode";
import { useEffect } from "react";

type EditorPanelProps = {
  doc: Doc;
  clientId: string;
  presence?: Presence;
  setPresence?: (selection: PresenceSelection | undefined) => void;
  user?: PresenceUser;
};

export function EditorPanel({
  doc,
  clientId,
  presence,
  setPresence,
  user,
}: EditorPanelProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900/50 shadow-2xl shadow-black/50 backdrop-blur-sm">
      <LexicalComposer
        initialConfig={{
          namespace: "MultiEditor",
          nodes: [HeadingNode],
          theme: {
            paragraph: "mb-2 text-zinc-200 leading-relaxed",
            heading: {
              h1: "text-3xl font-bold text-white mb-4 mt-2",
              h2: "text-2xl font-semibold text-zinc-100 mb-3 mt-2",
              h3: "text-xl font-medium text-zinc-200 mb-2 mt-2",
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
        <InitialContentPlugin clientId={clientId} />
        <ToolbarPlugin />
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-[400px] px-6 py-4 text-zinc-300 outline-none focus:outline-none" />
            }
            ErrorBoundary={LexicalErrorBoundary}
            placeholder={
              <div className="pointer-events-none absolute top-4 left-6 text-zinc-600">
                Start writing something amazing...
              </div>
            }
          />
        </div>
        <HistoryPlugin />
      </LexicalComposer>
    </div>
  );
}

function InitialContentPlugin({ clientId }: { clientId: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor) return;
    editor.update(() => {
      const root = $getRoot();
      if (clientId !== "reference" || root.getChildrenSize() !== 0) return;
      const p1 = $createParagraphNode();
      const p2 = $createParagraphNode();
      const p3 = $createParagraphNode();
      const text1 = $createTextNode("One");
      const text2 = $createTextNode("Two");
      const text3 = $createTextNode("Three");
      p1.append(text1);
      p2.append(text2);
      p3.append(text3);
      root.append(p1, p2, p3);
    });
  }, [editor, clientId]);

  return null;
}
