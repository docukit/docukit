import { Doc, type DocNode, type Operations } from "@docukit/docnode";
import { fromLegacyJson } from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
  assertDoc,
  checkUndoManager,
  text,
  textDoc,
  textDocConfig as config,
} from "./utils.js";

/** The index of a node's session in its document's table, and its clock. */
const numbers = (node: DocNode) => [node["_session"], node["_clock"]];

describe("each node keeps its id as numbers", () => {
  test("a created node: the index of its session and its clock", () => {
    const doc = textDoc();
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "a", "b"));
    });
    const [a, b] = [doc.root.first!, doc.root.last!];
    // The document's own session is the first of its table.
    expect(numbers(a)).toStrictEqual([0, 0]);
    expect(numbers(b)).toStrictEqual([0, 1]);
    expect(a.id.endsWith(".-")).toBe(true);
    expect(b.id.endsWith(".0")).toBe(true);
  });

  test("a node of another session, from operations or a stored document", () => {
    const a = textDoc();
    const b = Doc.fromJSON(config, a.toJSON());
    b.forceCommit();
    const sent: Operations[] = [];
    b.onChange(({ operations }) => sent.push(operations));
    b.root.append(...text(b, "b1", "b2"));
    b.forceCommit();
    for (const operations of sent) a.applyOperations(operations);
    a.forceCommit();
    a.root.append(...text(a, "a1"));
    a.forceCommit();
    const [b1, b2, a1] = [a.root.first!, a.root.first!.next!, a.root.last!];
    expect([b1, b2, a1].map(numbers)).toStrictEqual([
      [1, 0],
      [1, 1],
      [0, 0],
    ]);

    // A loaded document's own session is first; then the stored ones, in
    // the order its nodes have them.
    const loaded = Doc.fromJSON(config, a.toJSON());
    loaded.forceCommit();
    assertDoc(loaded, ["b1", "b2", "a1"]);
    const loadedNodes: DocNode[] = [];
    loaded.root.children().forEach((node) => loadedNodes.push(node));
    expect(loadedNodes.map(numbers)).toStrictEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
  });

  test("ids that are not `session.clock` keep no numbers", () => {
    let n = 0;
    const doc = new Doc({
      ...config,
      nodeIdGenerator: {
        generate: () => `ok-${n++}`,
        validate: (id) => id.startsWith("ok-"),
      },
    });
    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    expect(doc.root.first!["_session"]).toBe(-1);
    // Not written back the same from numbers: a clock with a leading zero,
    // a character out of the alphabet, more than 8 digits, no session or
    // no clock.
    const ids = ["s.-0", "s.é", "s.123456789", ".0", "x."];
    const loaded = Doc.fromJSON(
      config,
      fromLegacyJson([
        "01kc52hq510g6y44jhq0wqrjb3",
        "root",
        {},
        ids.map((id) => [id, "text", {}]),
      ]),
    );
    expect(loaded.root["_session"]).toBe(-1);
    loaded.root.children().forEach((node) => {
      expect(node["_session"]).toBe(-1);
    });
  });

  test("operations with an invalid id of a custom generator insert nothing", () => {
    const doc = new Doc({
      ...config,
      nodeIdGenerator: {
        generate: () => "ok-1",
        validate: (id) => id.startsWith("ok-"),
      },
    });
    doc.applyOperations([[[0, [["bad", "text"]], 0, 0, 0]], {}]);
    doc.forceCommit();
    expect(doc.root.first).toBeUndefined();
    doc.applyOperations([[[0, [["ok-2", "text"]], 0, 0, 0]], {}]);
    doc.forceCommit();
    expect(doc.root.first!.id).toBe("ok-2");
  });
});
