"use client";

import { useMemo } from "react";
import { HeadingNode } from "@lexical/rich-text";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { LexicalCollaboration } from "@lexical/react/LexicalCollaborationContext";
import ToolbarPlugin from "./ToolbarPlugin";
import { Doc as YDoc } from "yjs";
import { DocSyncYjsProvider } from "../utils/DocSyncYjsProvider";

export function EditorPanel({ doc, docId }: { doc: YDoc; docId: string }) {
  // Create a fresh Y.Doc for the CollaborationPlugin.
  // DocSyncYjsProvider bridges it with the DocSync-managed doc.
  const editorDoc = useMemo(() => new YDoc(), []);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900/50 shadow-2xl shadow-black/50 backdrop-blur-sm">
      <LexicalComposer
        initialConfig={{
          namespace: "MultiEditorYjs",
          nodes: [HeadingNode],
          // Prevent default empty paragraph — content comes from Y.Doc via bridge.
          editorState: null,
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
        <LexicalCollaboration>
          <CollaborationPlugin
            id={docId}
            providerFactory={(id, yjsDocMap) => {
              yjsDocMap.set(id, editorDoc);
              return new DocSyncYjsProvider(doc, editorDoc);
            }}
            shouldBootstrap={false}
          />
        </LexicalCollaboration>
        <ToolbarPlugin />
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-100 px-6 py-4 text-zinc-300 outline-none focus:outline-none" />
            }
            ErrorBoundary={LexicalErrorBoundary}
            placeholder={
              <div className="pointer-events-none absolute top-4 left-6 text-zinc-600">
                Start writing something amazing...
              </div>
            }
          />
        </div>
      </LexicalComposer>
    </div>
  );
}
