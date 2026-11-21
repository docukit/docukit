import { defineNode, defineText, Doc } from "@docukit/docnode";
import { expect, test } from "vitest";

import { ROOT_ID } from "./utils.js";

/** A key rule by prefix, and no opaque letter. */
const Note = defineNode({
  type: "note",
  state: { t: defineText({ inherit: { "comment:*": "both" } }) },
});

test("a rule by prefix names every key that starts with it", () => {
  const doc = new Doc({
    type: "root",
    id: ROOT_ID,
    extensions: [{ nodes: [Note] }],
  });
  doc.forceCommit();
  const note = doc.createNode(Note);
  doc.root.append(note);
  const text = note.state.t;
  text.insert(0, "abc");
  text.format(0, 3, "comment:1", "x");
  text.format(0, 3, "other", "y");
  doc.forceCommit();
  // Inside the comment: typed letters get it, not the key without a rule.
  text.insert(1, "Z");
  // At its edge: not inside it.
  text.insert(4, "!");
  expect(text.spans()).toStrictEqual([
    { text: "a", attrs: { "comment:1": "x", other: "y" } },
    { text: "Z", attrs: { "comment:1": "x" } },
    { text: "bc", attrs: { "comment:1": "x", other: "y" } },
    { text: "!", attrs: {} },
  ]);
});
