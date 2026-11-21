import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  FOCUS_COMMAND,
  createEditor,
} from "lexical";
import { describe, expect, test, vi } from "vitest";
import {
  syncLexicalWithDoc,
  type PresenceSelection,
  type PresenceUser,
} from "@docukit/docnode-lexical";

import { createLexicalDoc } from "./utils.js";

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

/**
 * The user an editor sends with its presence, once "hello" is selected from 1
 * to 4. Throws if it sends no selection.
 */
function readPresence(user?: PresenceUser) {
  const editor = createEditor({
    namespace: "PresenceTest",
    onError: (error) => {
      throw error;
    },
  });
  let presence: PresenceSelection | undefined;
  const cleanup = syncLexicalWithDoc(editor, createLexicalDoc(), {
    setPresence: (selection) => {
      presence = selection;
    },
    user,
  });
  editor.update(
    () => {
      const text = $createTextNode("hello");
      $getRoot().append($createParagraphNode().append(text));
      text.select(1, 4);
    },
    { discrete: true },
  );

  editor.dispatchCommand(FOCUS_COMMAND, new FocusEvent("focus"));
  cleanup();

  if (!presence) throw new Error("Expected a presence");
  const { anchor, focus, ...sentUser } = presence;
  // Each end is right before a letter: "e" and "o".
  expect([anchor.offset, focus.offset]).toStrictEqual([0, 0]);
  expect(anchor.key).not.toBe(focus.key);
  return sentUser;
}

describe("presence defaults", () => {
  test("uses Anonymous and a random curated color by default", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const presence = readPresence();

    expect(presence.name).toBe("Anonymous");
    expect(DEFAULT_COLORS).toContain(presence.color);
    expect(random).toHaveBeenCalled();
    random.mockRestore();
  });

  test("keeps a provided name and fills in a deterministic color", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const firstPresence = readPresence({ name: "Ada" });

    random.mockReturnValue(0.9);
    const secondPresence = readPresence({ name: "Ada" });

    expect(firstPresence.name).toBe("Ada");
    expect(DEFAULT_COLORS).toContain(firstPresence.color);
    expect(secondPresence.color).toBe(firstPresence.color);
    random.mockRestore();
  });

  test("keeps a provided color and fills in the default name", () => {
    expect(readPresence({ color: "#123456" })).toStrictEqual({
      color: "#123456",
      name: "Anonymous",
    });
  });
});
