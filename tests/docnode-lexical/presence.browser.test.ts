import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  FOCUS_COMMAND,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { describe, expect, test, vi } from "vitest";
import {
  syncPresence,
  type KeyBinding,
  type PresenceSelection,
  type PresenceUser,
} from "@docukit/docnode-lexical";

const DEFAULT_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#4f46e5",
  "#dc2626",
  "#0d9488",
  "#7c3aed",
  "#ca8a04",
  "#0284c7",
];

function createPresenceEditor(): {
  editor: LexicalEditor;
  keyBinding: KeyBinding;
} {
  const editor = createEditor({
    namespace: "PresenceTest",
    onError: (error) => {
      throw error;
    },
  });

  let textKey = "";
  editor.update(
    () => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const text = $createTextNode("hello");
      textKey = text.getKey();
      paragraph.append(text);
      root.clear();
      root.append(paragraph);

      const selection = $createRangeSelection();
      selection.anchor.set(textKey, 1, "text");
      selection.focus.set(textKey, 4, "text");
      $setSelection(selection);
    },
    { discrete: true },
  );

  return {
    editor,
    keyBinding: {
      lexicalKeyToDocNodeId: new Map([[textKey, "docnode-text"]]),
      docNodeIdToLexicalKey: new Map([["docnode-text", textKey]]),
    },
  };
}

function readPresence(user?: PresenceUser): PresenceSelection | undefined {
  const { editor, keyBinding } = createPresenceEditor();
  let presence: PresenceSelection | undefined;
  const cleanup = syncPresence(editor, keyBinding, {
    setPresence: (selection) => {
      presence = selection;
    },
    user,
  });

  editor.dispatchCommand(FOCUS_COMMAND, new FocusEvent("focus"));
  cleanup?.();

  return presence;
}

describe("presence defaults", () => {
  test("does not enable presence when setPresence is omitted", () => {
    const { editor, keyBinding } = createPresenceEditor();
    const cleanup = syncPresence(editor, keyBinding);

    expect(cleanup).toBeUndefined();
  });

  test("uses Anonymous and a random curated color by default", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const presence = readPresence();

    expect(presence).toMatchObject({
      anchor: { key: "docnode-text", offset: 1 },
      focus: { key: "docnode-text", offset: 4 },
      name: "Anonymous",
    });
    expect(DEFAULT_COLORS).toContain(presence?.color);
    expect(random).toHaveBeenCalled();
    random.mockRestore();
  });

  test("keeps a provided name and fills in a deterministic color", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const firstPresence = readPresence({ name: "Ada" });

    random.mockReturnValue(0.9);
    const secondPresence = readPresence({ name: "Ada" });

    expect(firstPresence).toMatchObject({
      anchor: { key: "docnode-text", offset: 1 },
      focus: { key: "docnode-text", offset: 4 },
      name: "Ada",
    });
    expect(DEFAULT_COLORS).toContain(firstPresence?.color);
    expect(secondPresence?.color).toBe(firstPresence?.color);
    random.mockRestore();
  });

  test("keeps a provided color and fills in the default name", () => {
    expect(readPresence({ color: "#123456" })).toStrictEqual({
      anchor: { key: "docnode-text", offset: 1 },
      color: "#123456",
      focus: { key: "docnode-text", offset: 4 },
      name: "Anonymous",
    });
  });
});
