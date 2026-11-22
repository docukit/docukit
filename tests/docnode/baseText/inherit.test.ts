import { defineNode, defineText, Doc, type Operations } from "@docukit/docnode";
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

test("a key letters inherit is written in the state row as a key of its own", () => {
  const Inheriting = defineNode({
    type: "note",
    state: { t: defineText({ inherit: { "0": "origin", link: "origin" } }) },
  });
  const config = {
    type: "root",
    id: ROOT_ID,
    extensions: [{ nodes: [Inheriting] }],
  };
  const doc = new Doc(config);
  doc.forceCommit();
  const note = doc.createNode(Inheriting);
  doc.root.append(note);
  note.state.t.insert(0, "abc");
  doc.forceCommit();
  const replica = Doc.fromJSON(config, doc.toJSON());
  const batches: Operations[] = [];
  doc.onChange(({ operations }) => batches.push(operations));
  note.state.t.format(0, 2, "0", 1);
  doc.forceCommit();
  note.state.t.format(1, 3, "link", "x");
  doc.forceCommit();
  // The key `0` is `-1`; a key that is not a number goes in a list.
  expect(batches.map((batch) => batch[1])).toStrictEqual([5, 5]);
  expect(batches[0]![2]).toBe(-1);
  expect(batches[1]![2]).toStrictEqual(["link"]);
  for (const batch of batches) replica.applyOperations(batch);
  replica.forceCommit();
  const copy = replica.getNodeById(note.id);
  expect(copy?.is(Inheriting) && copy.state.t.spans()).toStrictEqual(
    note.state.t.spans(),
  );
});
