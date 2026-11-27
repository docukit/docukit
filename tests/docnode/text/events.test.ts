import { Doc, type Diff } from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { getPrevError } from "../utils.js";
import {
  Paragraph,
  config,
  docWithParagraph,
  first,
  orderedServer,
  paragraph,
} from "./utils.js";

describe("text events", () => {
  test("changes() has the changes of the transaction in order", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "Hola mundo");
    doc.forceCommit();
    body.delete(4, 6);
    body.insert(4, "!");
    body.set("¡Hola!");
    expect(body.changes()).toStrictEqual([
      { index: 4, deleted: 6, inserted: "" },
      { index: 4, deleted: 0, inserted: "!" },
      { index: 0, deleted: 0, inserted: "¡" },
    ]);
    doc.forceCommit();
    expect(body.changes()).toStrictEqual([]);
  });

  test("a change of a text puts its node in diff.updated, and fires the change event", () => {
    const { doc, node, body } = docWithParagraph();
    const diffs: Diff[] = [];
    doc.onChange(({ diff }) => diffs.push(diff));
    body.insert(0, "a");
    doc.forceCommit();
    expect([...diffs[0]!.updated]).toStrictEqual([node.id]);
    // A node inserted in the transaction is in diff.inserted only.
    const other = paragraph(doc, "b");
    other.state.body.insert(1, "c");
    doc.forceCommit();
    expect([...diffs[1]!.inserted]).toStrictEqual([other.id]);
    expect(diffs[1]!.updated.size).toBe(0);
  });

  test("getPrev() rebuilds the text at the start of the transaction", () => {
    const { doc, node, body } = docWithParagraph();
    body.insert(0, "Hola mundo");
    doc.forceCommit();
    expect(() => body.getPrev()).toThrowError(getPrevError);
    body.delete(4, 6);
    body.set("¡Hola!");
    expect(body.getPrev()).toStrictEqual([true, "Hola mundo"]);
    doc.forceCommit();
    body.insert(0, "x");
    body.delete(0, 1);
    expect(body.getPrev()).toStrictEqual([false, "¡Hola!"]);
    doc.forceCommit();
    node.state.bold.set(true);
    expect(body.getPrev()).toStrictEqual([false, "¡Hola!"]);
  });

  test("setting a key back keeps the node updated if its text changed", () => {
    const { doc, node, body } = docWithParagraph();
    node.state.title.set("t");
    body.insert(0, "a");
    node.state.title.set("");
    expect(doc["_diff"].updated.has(node.id)).toBe(true);
    doc.forceCommit();
    node.state.title.set("t");
    node.state.title.set("");
    expect(doc["_diff"].updated.has(node.id)).toBe(false);
  });

  test("remote changes are in changes() too", () => {
    const { replica, edit } = orderedServer((doc) => paragraph(doc, "ab"));
    const [docA, docB] = [replica(), replica()];
    const batches = edit(docA, () => {
      first(docA).state.body.insert(1, "X");
      first(docA).state.body.delete(0, 1);
    });
    const changes: unknown[] = [];
    docB.onChange(({ diff }) =>
      diff.updated.forEach((id) => {
        const node = docB.getNodeById(id);
        if (node?.is(Paragraph)) changes.push(...node.state.body.changes());
      }),
    );
    docB.applyOperations(batches[0]!);
    docB.forceCommit();
    expect(changes).toStrictEqual([
      { index: 1, deleted: 0, inserted: "X" },
      { index: 0, deleted: 1, inserted: "" },
    ]);
  });

  test("normalize listeners see the changes", () => {
    const seen: unknown[] = [];
    const doc = new Doc({
      ...config,
      extensions: [
        ...config.extensions,
        {
          register: (doc) =>
            doc.onNormalize(({ diff }) =>
              diff.updated.forEach((id) => {
                const node = doc.getNodeById(id);
                if (node?.is(Paragraph)) seen.push(node.state.body.changes());
              }),
            ),
        },
      ],
    });
    const node = paragraph(doc);
    doc.forceCommit();
    node.state.body.insert(0, "a");
    doc.forceCommit();
    // Strict mode normalizes twice.
    expect(seen).toStrictEqual([
      [{ index: 0, deleted: 0, inserted: "a" }],
      [{ index: 0, deleted: 0, inserted: "a" }],
    ]);
  });
});
