"use client";

import { HeadingNode } from "@lexical/rich-text";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import ToolbarPlugin from "./ToolbarPlugin";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
} from "lexical";
import type { PresenceSelection } from "@docukit/docnode-lexical";
import {
  DocNodePlugin,
  type Presence,
  type PresenceUser,
} from "@docukit/docnode-lexical/react";
import { UndoManager, type Doc } from "@docukit/docnode";
import { useEffect, useMemo } from "react";

const undoManagers = new WeakMap<Doc, UndoManager>();

export function EditorPanel({
  doc,
  presence,
  setPresence,
  user,
}: {
  doc: Doc;
  clientId: string;
  presence?: Presence;
  setPresence?: (selection: PresenceSelection | undefined) => void;
  user?: PresenceUser;
}) {
  const undoManager = useMemo(() => {
    let manager = undoManagers.get(doc);
    if (!manager) {
      manager = new UndoManager(doc);
      undoManagers.set(doc, manager);
    }
    return manager;
  }, [doc]);

  return (
    <div className="border-fd-border bg-fd-background overflow-hidden rounded-lg border shadow-sm">
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
          undoManager={undoManager}
        />
        <InitialContentPlugin clientId={clientId} undoManager={undoManager} />
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
    </div>
  );
}

function InitialContentPlugin({
  clientId,
  undoManager,
}: {
  clientId: string;
  undoManager: UndoManager;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor) return;
    let seeded = false;
    editor.update(
      () => {
        const root = $getRoot();
        if (clientId !== "reference" || root.getChildrenSize() !== 0) return;
        const p1 = $createParagraphNode();
        const p2 = $createParagraphNode();
        const p3 = $createParagraphNode();
        const text1 = $createTextNode("Item one.");
        const text2 = $createTextNode("Item two.");
        const text3 = $createTextNode("Item three.");
        p1.append(text1);
        p2.append(text2);
        p3.append(text3);
        root.append(p1, p2, p3);
        seeded = true;
      },
      { discrete: true },
    );
    if (!seeded) return;
    // Clear the initial seed so it does not enter the UndoManager.
    undoManager.clear();
    editor.dispatchCommand(CAN_UNDO_COMMAND, false);
    editor.dispatchCommand(CAN_REDO_COMMAND, false);
  }, [editor, clientId, undoManager]);

  return null;
}
