import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { render } from "vitest-browser-react";
import { expect } from "vitest";
import type { Doc, JsonDoc, Operations } from "@docukit/docnode";
import type { DocSyncClient } from "@docukit/docsync/client";
import {
  SKIP_UNDO_TAG,
  type LexicalPresence,
  type Presence,
} from "@docukit/docnode-lexical";
import { DocNodePlugin } from "@docukit/docnode-lexical/react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  UNDO_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
} from "lexical";

import { shownCaret } from "../../docnode-lexical/utils.js";
import { LEXICAL_DOC_TYPE, readStoredCopy, testWrapper } from "./utils.js";

type Client = DocSyncClient<Doc, JsonDoc, Operations>;

/** A point as (top-level block, offset in the block's text). */
export type BlockPoint = { block: number; offset: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPoint = (value: unknown) =>
  isRecord(value) &&
  typeof value.key === "string" &&
  typeof value.offset === "number";

/** Presence a DocSync peer sent, as the Lexical binding shows it. */
const isLexicalPresence = (value: unknown): value is LexicalPresence =>
  isRecord(value) &&
  isPoint(value.anchor) &&
  isPoint(value.focus) &&
  typeof value.name === "string" &&
  typeof value.color === "string";

/** The presence of the other devices that is a Lexical selection. */
function lexicalPresence(presence: Record<string, unknown>): Presence {
  const result: Presence = {};
  for (const [id, value] of Object.entries(presence))
    if (isLexicalPresence(value)) result[id] = value;
  return result;
}

/**
 * An editor that shows a DocSync document and its presence, as an app with
 * `useDoc` and `usePresence` does.
 */
function SyncedEditor({
  client,
  docId,
  type,
  name,
  onEditor,
  onDoc,
}: {
  client: Client;
  docId: string;
  type: string;
  name: string;
  onEditor: (editor: LexicalEditor | null) => void;
  onDoc: (doc: Doc) => void;
}) {
  const observer = useMemo(
    () => client.getDocObserver({ type, id: docId, createIfMissing: true }),
    [client, type, docId],
  );
  const result = useSyncExternalStore(observer.subscribe, observer.getSnapshot);
  const doc = result.data?.doc;
  if (doc) onDoc(doc);
  const [presence, setPresence] = useState<Presence>({});
  useEffect(() => {
    if (!doc) return;
    return client.getPresence({ docId }, (value) =>
      setPresence(lexicalPresence(value)),
    );
  }, [client, docId, doc]);
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "docsync-lexical",
        onError: (error) => {
          throw error;
        },
      }}
    >
      <ContentEditable />
      <EditorRefPlugin editorRef={onEditor} />
      {doc ? (
        <DocNodePlugin
          doc={doc}
          presence={presence}
          setPresence={(selection) =>
            client.setPresence({ docId, presence: selection })
          }
          user={{ name, color: "#2563eb" }}
        />
      ) : null}
    </LexicalComposer>
  );
}

/** The text node and offset of `offset` in the `block`-th paragraph. */
function $textPointAt({ block, offset }: BlockPoint) {
  const paragraph = $getRoot().getChildAtIndex(block);
  if (!$isElementNode(paragraph)) throw new Error(`No block ${block}`);
  let rest = offset;
  for (const child of paragraph.getChildren()) {
    const size = child.getTextContentSize();
    if ($isTextNode(child) && rest <= size)
      return { key: child.getKey(), offset: rest };
    rest -= size;
  }
  throw new Error(`No offset ${offset} in block ${block}`);
}

/** The top-level block of `point` and the text before it in that block. */
function $blockPointOf(point: PointType): BlockPoint | undefined {
  let node: LexicalNode = point.getNode();
  let offset = point.offset;
  if ($isElementNode(node)) {
    offset = 0;
    for (const child of node.getChildren().slice(0, point.offset))
      offset += child.getTextContentSize();
  }
  for (let parent = node.getParent(); parent; parent = node.getParent()) {
    if (parent === $getRoot())
      return { block: node.getIndexWithinParent(), offset };
    for (const sibling of node.getPreviousSiblings())
      offset += sibling.getTextContentSize();
    node = parent;
  }
  return undefined;
}

async function lexicalClient(
  client: Client,
  docId: string,
  type: string,
  name: string,
) {
  let editor: LexicalEditor | undefined;
  const docs: Doc[] = [];
  const screen = await render(
    <SyncedEditor
      client={client}
      docId={docId}
      type={type}
      name={name}
      onEditor={(value) => {
        editor = value ?? undefined;
      }}
      onDoc={(doc) => {
        if (docs.at(-1) !== doc) docs.push(doc);
      }}
    />,
  );
  const update = (change: () => void, tag?: string) => {
    if (!editor) throw new Error("Editor not mounted");
    editor.update(change, { discrete: true, ...(tag && { tag }) });
  };
  const read = <T,>(reader: () => T): T => {
    if (!editor) throw new Error("Editor not mounted");
    return editor.getEditorState().read(reader);
  };
  const texts = () =>
    read(() =>
      $getRoot()
        .getChildren()
        .map((child) => child.getTextContent()),
    );
  /** The selection, or `undefined` when there is none or it is not in a block. */
  const selection = () =>
    read(() => {
      const current = $getSelection();
      if (!$isRangeSelection(current)) return undefined;
      const anchor = $blockPointOf(current.anchor);
      const focus = $blockPointOf(current.focus);
      return anchor && focus ? { anchor, focus } : undefined;
    });

  const root = () => {
    const element = editor?.getRootElement();
    if (!element) throw new Error("Editor not mounted");
    return element;
  };

  return {
    name,
    /** Every document the editor was bound to, in order. */
    docs,
    unmount: () => screen.unmount(),
    /** Writes paragraphs that undo does not take back, once the doc loaded. */
    load: async (paragraphs: string[]) => {
      await expect.poll(() => docs.length).toBe(1);
      update(() => {
        $getRoot().append(
          ...paragraphs.map((text) =>
            $createParagraphNode().append($createTextNode(text)),
          ),
        );
      }, SKIP_UNDO_TAG);
    },
    /** Focuses the editor: its selection is then sent as presence. */
    focus: () => root().focus(),
    select: (anchor: BlockPoint, focus = anchor) => {
      update(() => {
        const range = $createRangeSelection();
        const start = $textPointAt(anchor);
        const end = $textPointAt(focus);
        range.anchor.set(start.key, start.offset, "text");
        range.focus.set(end.key, end.offset, "text");
        $setSelection(range);
      });
    },
    /** Types at the selection. */
    type: (text: string) => {
      update(() => {
        $getSelection()?.insertText(text);
      });
    },
    undo: () => editor?.dispatchCommand(UNDO_COMMAND, undefined),
    assertTexts: async (expected: string[]) => {
      await expect.poll(texts).toStrictEqual(expected);
    },
    /** Where this editor shows the caret of `other`: see `shownCaret`. */
    assertCaretOf: async (other: { name: string }, expected: string[]) => {
      await expect
        .poll(() => shownCaret(root(), other.name))
        .toStrictEqual(expected);
    },
    assertSelection: async (anchor: BlockPoint, focus = anchor) => {
      await expect.poll(selection).toStrictEqual({ anchor, focus });
    },
    /** Waits until IndexedDB holds the edits not yet sent. */
    assertPendingEdits: async () => {
      await expect
        .poll(async () => (await readStoredCopy(client, docId)).pending.length)
        .toBeGreaterThan(0);
    },
    /** Waits until the server acknowledged every edit of this client. */
    assertSynced: async () => {
      await expect
        .poll(async () => {
          const { stored, pending } = await readStoredCopy(client, docId);
          const doc = docs.at(-1);
          return (
            pending.length === 0 &&
            stored !== undefined &&
            doc !== undefined &&
            JSON.stringify(stored.doc.toJSON()) === JSON.stringify(doc.toJSON())
          );
        })
        .toBe(true);
    },
  };
}

type LexicalClient = Awaited<ReturnType<typeof lexicalClient>>;

/**
 * Two devices with an editor on the same Lexical document. `reference` can go
 * offline; `otherDevice` stays online.
 */
export const lexicalTestWrapper = async (
  callback: (setup: {
    reference: LexicalClient & { disconnect: () => void; connect: () => void };
    otherDevice: LexicalClient;
  }) => Promise<void>,
  type = LEXICAL_DOC_TYPE,
) => {
  await testWrapper(async ({ docId, reference, otherDevice }) => {
    const referenceEditor = await lexicalClient(
      reference.client,
      docId,
      type,
      "reference",
    );
    const otherEditor = await lexicalClient(
      otherDevice.client,
      docId,
      type,
      "other",
    );
    try {
      await callback({
        reference: {
          ...referenceEditor,
          disconnect: reference.disconnect,
          connect: reference.connect,
        },
        otherDevice: otherEditor,
      });
    } finally {
      await referenceEditor.unmount();
      await otherEditor.unmount();
    }
  });
};
