"use client";

import { HeadingNode } from "@lexical/rich-text";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import ToolbarPlugin from "./ToolbarPlugin";
import {
  $getRoot,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  type RootNode,
} from "lexical";
import type { PresenceSelection } from "@docukit/docnode-lexical";
import {
  DocNodePlugin,
  type Presence,
  type PresenceUser,
} from "@docukit/docnode-lexical/react";
import { type Doc } from "@docukit/docnode";
import { useEffect } from "react";

export type InitializeEditor = (root: RootNode) => void;

export function EditorPanel({
  doc,
  presence,
  setPresence,
  user,
  initializeEditor,
}: {
  doc: Doc;
  clientId: string;
  initializeEditor?: InitializeEditor;
  presence?: Presence;
  setPresence?: (selection: PresenceSelection | undefined) => void;
  user?: PresenceUser;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "MultiEditor",
        nodes: [HeadingNode],
        theme: {
          paragraph: "mb-2 text-fd-foreground leading-relaxed",
          heading: {
            h1: "text-3xl font-bold text-fd-foreground mb-4 mt-2",
            h2: "text-2xl font-semibold text-fd-foreground mb-3 mt-2",
            h3: "text-xl font-medium text-fd-foreground mb-2 mt-2",
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
      {initializeEditor ? (
        <InitialContentPlugin initializeEditor={initializeEditor} doc={doc} />
      ) : null}
      <ToolbarPlugin />
      <div className="relative">
        <RichTextPlugin
          contentEditable={
            <ContentEditable className="text-fd-foreground min-h-100 px-6 py-4 outline-none focus:outline-none" />
          }
          ErrorBoundary={LexicalErrorBoundary}
          placeholder={
            <div className="text-fd-muted-foreground pointer-events-none absolute top-4 left-6">
              Start writing something amazing...
            </div>
          }
        />
      </div>
    </LexicalComposer>
  );
}

function InitialContentPlugin({
  initializeEditor,
  doc,
}: {
  initializeEditor: InitializeEditor;
  doc: Doc;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor) return;
    let seeded = false;
    editor.update(
      () => {
        const root = $getRoot();
        if (root.getChildrenSize() !== 0) return;
        initializeEditor(root);
        seeded = true;
      },
      { discrete: true },
    );
    if (!seeded) return;
    // Clear the initial seed so it does not enter the UndoManager.
    doc.undoManager.clear();
    editor.dispatchCommand(CAN_UNDO_COMMAND, false);
    editor.dispatchCommand(CAN_REDO_COMMAND, false);
  }, [editor, initializeEditor, doc]);

  return null;
}
