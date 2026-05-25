"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import * as Y from "yjs";
import {
  createBinding,
  syncLexicalUpdateToYjs,
  type Provider,
} from "@lexical/yjs";
import { COLLABORATION_TAG } from "lexical";
import type { Doc } from "@docukit/docnode";

const STUB_PROVIDER = {
  awareness: {
    on: () => {},
    off: () => {},
    getLocalState: () => null,
    getStates: () => new Map(),
    setLocalState: () => {},
    setLocalStateField: () => {},
  },
  connect: () => {},
  disconnect: () => {},
  on: () => {},
  off: () => {},
} satisfies Provider;

async function getGzipSize(data: Uint8Array): Promise<number> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writer.write(data as any);
  writer.close();
  const reader = cs.readable.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
}

export type SizeMeasurement = {
  yjsGz: number;
  docNodeGz: number;
  editorStateGz: number;
};

export function SizeBenchPlugin({
  doc,
  onMeasure,
}: {
  doc: Doc;
  onMeasure: (m: SizeMeasurement) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let yDoc: Y.Doc;
    let binding: ReturnType<typeof createBinding>;

    try {
      yDoc = new Y.Doc();
      yDoc.get("root", Y.XmlText);
      binding = createBinding(editor, STUB_PROVIDER, "main", yDoc, new Map());
    } catch (e) {
      console.error("[SizeBench] Failed to create binding", e);
      return;
    }

    const unregister = editor.registerUpdateListener(
      ({
        editorState,
        prevEditorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        // Skip selection-only changes (no content changed)
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

        // Strip COLLABORATION_TAG so Yjs mirrors ALL editor state
        const strippedTags = new Set(tags);
        strippedTags.delete(COLLABORATION_TAG);

        try {
          syncLexicalUpdateToYjs(
            binding,
            STUB_PROVIDER,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            strippedTags,
          );
        } catch (e) {
          console.error("[SizeBench] Yjs sync error", e);
        }

        const yjsBytes = Y.encodeStateAsUpdate(yDoc);
        const docNodeBytes = new TextEncoder().encode(
          JSON.stringify(doc.toJSON({ unsafe: true })),
        );
        const editorStateBytes = new TextEncoder().encode(
          JSON.stringify(editorState.toJSON()),
        );

        Promise.all([
          getGzipSize(yjsBytes),
          getGzipSize(docNodeBytes),
          getGzipSize(editorStateBytes),
        ]).then(([yjsGz, docNodeGz, editorStateGz]) => {
          onMeasure({ yjsGz, docNodeGz, editorStateGz });
        });
      },
    );

    return () => {
      unregister();
      yDoc.destroy();
    };
    // onMeasure is intentionally excluded — caller must provide a stable ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc]);

  return null;
}
