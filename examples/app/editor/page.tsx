"use client";

import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import ToolbarPlugin from "./ToolbarPlugin";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

export default function LexicalPage() {
  return (
    <div className="bg-linear-to-br flex min-h-screen flex-col items-center from-zinc-950 via-zinc-900 to-zinc-950 px-4 py-12">
      {/* Editor Container */}
      <div className="w-full max-w-2xl">
        <div className="overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900/50 shadow-2xl shadow-black/50 backdrop-blur-sm">
          <LexicalComposer
            initialConfig={{
              namespace: "MyEditor",
              editorState: () => {
                const root = $getRoot();

                const h1 = $createHeadingNode("h1");
                h1.append($createTextNode("Welcome to Lexical"));
                root.append(h1);

                const intro = $createParagraphNode();
                intro.append(
                  $createTextNode(
                    "This is a modern rich text editor built with Lexical. It supports formatting, headings, and more.",
                  ),
                );
                root.append(intro);

                const h2 = $createHeadingNode("h2");
                h2.append($createTextNode("Getting Started"));
                root.append(h2);

                const p1 = $createParagraphNode();
                p1.append(
                  $createTextNode(
                    "Use the toolbar above to format your text. You can make text bold, italic, underlined, or strikethrough.",
                  ),
                );
                root.append(p1);

                const p2 = $createParagraphNode();
                p2.append(
                  $createTextNode(
                    "You can also change the block type to create headings of different sizes, or align your text left, center, right, or justified.",
                  ),
                );
                root.append(p2);

                const h3 = $createHeadingNode("h3");
                h3.append($createTextNode("Keyboard Shortcuts"));
                root.append(h3);

                const p3 = $createParagraphNode();
                p3.append(
                  $createTextNode(
                    "Press Ctrl+B for bold, Ctrl+I for italic, Ctrl+U for underline. Use Ctrl+Z to undo and Ctrl+Y to redo.",
                  ),
                );
                root.append(p3);
              },
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
              onError: (error) => {
                console.error(error);
              },
            }}
          >
            <ToolbarPlugin />
            <div className="relative">
              <RichTextPlugin
                contentEditable={
                  <ContentEditable className="min-h-[400px] px-6 py-4 text-zinc-300 outline-none focus:outline-none" />
                }
                ErrorBoundary={LexicalErrorBoundary}
                placeholder={
                  <div className="pointer-events-none absolute left-6 top-4 text-zinc-600">
                    Start writing something amazing...
                  </div>
                }
              />
            </div>
            <HistoryPlugin />
          </LexicalComposer>
        </div>
      </div>
    </div>
  );
}
