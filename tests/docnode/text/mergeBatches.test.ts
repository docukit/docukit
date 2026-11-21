import { describe, expect, test } from "vitest";
import {
  defineNode,
  Doc,
  type DocConfig,
  mergeBatches,
  type Operations,
  string,
} from "@docukit/docnode";
import { Paragraph, type ParagraphNode } from "./utils.js";

const Item = defineNode({ type: "item", state: { label: string("") } });

/** A document that keeps every batch it writes, and how it started. */
function writer() {
  const config: DocConfig = {
    type: "root",
    extensions: [{ nodes: [Paragraph, Item] }],
  };
  const doc = new Doc(config);
  doc.forceCommit();
  const start = doc.toJSON();
  const batches: Operations[] = [];
  doc.onChange((event) => batches.push(structuredClone(event.operations)));
  /** The document `operations` make of where this one started. */
  const replay = (operations: Operations[]) => {
    const replica = Doc.fromJSON({ ...config, id: doc.root.id }, start);
    for (const batch of operations) replica.applyOperations(batch);
    replica.forceCommit();
    return replica.toJSON();
  };
  return { doc, batches, replay };
}

/** Types `letters` at the end of `paragraph`, one batch per letter. */
function type(paragraph: ParagraphNode, letters: string) {
  for (const letter of letters) {
    paragraph.state.t.insert(paragraph.state.t.get().length, letter);
    paragraph.doc.forceCommit();
  }
}

describe("mergeBatches", () => {
  test("merges each run of batches that only edit text, and nothing else", () => {
    const { doc, batches, replay } = writer();
    const paragraph = doc.createNode(Paragraph);
    doc.root.append(paragraph);
    doc.forceCommit();
    type(paragraph, "ab");
    const item = doc.createNode(Item);
    doc.root.append(item);
    doc.forceCommit();
    item.state.label.set("x");
    doc.forceCommit();
    type(paragraph, "c");

    const merged = mergeBatches(batches);
    // The paragraph, "ab", the item, its label, "c".
    expect(merged).toHaveLength(5);
    expect(replay(merged)).toStrictEqual(replay(batches));
    expect(replay(merged)).toStrictEqual(doc.toJSON());
  });
});
