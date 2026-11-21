import { Doc, type DocNode } from "@docukit/docnode";
import { labelsSnapshot } from "@docukit/docnode/crdt";
import { describe, expect, test } from "vitest";

import {
  Paragraph,
  ROOT_ID,
  peers,
  replica,
  texts,
  type Replica,
} from "./utils.js";

/** Normalize: the paragraph "Z" is always the root's last child. */
function keepZLast(doc: Doc) {
  let z: DocNode | undefined;
  doc.root.children().forEach((node) => {
    if (node.is(Paragraph) && node.state.t.get() === "Z") z = node;
  });
  if (z && z !== doc.root.last) z.move(doc.root, "append");
}

/** A stored document with the paragraphs `values`. */
function genesis(...values: string[]) {
  const first = replica("g");
  for (const value of values) first.append(value);
  return first.stored();
}

describe("fugue places", () => {
  test("two replicas writing upward offline keep their paragraphs together", () => {
    const [a, b] = peers(["a", "b"], genesis("P0", "Z"));
    for (const [peer, name] of [
      [a!, "A"],
      [b!, "B"],
    ] as const) {
      let next = peer.doc.root.last!;
      for (let i = 1; i <= 3; i++) next = peer.before(next, `${name}${i}`);
    }
    a!.receive(b!.take());
    b!.receive(a!.take());
    expect(texts(a!)).toBe("P0 A3 A2 A1 B3 B2 B1 Z");
    expect(texts(b!)).toBe(texts(a!));
  });

  test("a move whose origins have not arrived lands in place once they do", () => {
    const json = genesis("x", "y");
    const [a, c] = peers(["a", "c"], json);
    const n = a!.append("n");
    const insert = a!.take();
    a!.get(a!.doc.root.first!.id).move(n, "after");
    a!.doc.forceCommit();
    const move = a!.take();
    c!.receive(move);
    expect(texts(c!)).toContain("x");
    c!.receive(insert);
    expect(texts(a!)).toBe("y n x");
    expect(texts(c!)).toBe(texts(a!));
  });

  test("a replica stored while a place waits loads it and converges", () => {
    const [a, c] = peers(["a", "c"], genesis("x", "y"));
    const n = a!.append("n");
    const insert = a!.take();
    a!.before(n, "m");
    c!.receive(a!.take());
    const reloaded = replica("c", c!.stored());
    reloaded.receive(insert);
    expect(texts(reloaded)).toBe("x y m n");
    expect(texts(a!)).toBe(texts(reloaded));
  });

  test("a document stored without places gets the same ones on every replica", () => {
    const plain = new Doc({
      id: ROOT_ID,
      type: "root",
      extensions: [{ nodes: [Paragraph] }],
    });
    for (const value of ["x", "y"]) {
      const node = plain.createNode(Paragraph);
      node.state.t.set(value);
      plain.root.append(node);
    }
    plain.forceCommit();
    const [a, b] = peers(["a", "b"], plain.toJSON());
    a!.before(a!.doc.root.last!, "a");
    b!.before(b!.doc.root.last!, "b");
    a!.receive(b!.take());
    b!.receive(a!.take());
    expect(texts(a!)).toBe("x a b y");
    expect(texts(b!)).toBe(texts(a!));
  });

  test("a document without places loads and takes new ones", () => {
    const [a, b] = peers(["a", "b"], genesis());
    a!.append("x");
    b!.receive(a!.take());
    expect(texts(b!)).toBe("x");
  });

  test("replicas that repair the same merge make the same place", () => {
    const json = genesis("P", "Z");
    const [a, b] = peers(["a", "b"], json, keepZLast);
    // a's later clock wins Z's place, which leaves b's paragraph after it.
    const first = a!.doc.root.first;
    if (first?.is(Paragraph)) first.state.t.set("P!");
    a!.doc.forceCommit();
    a!.append("X");
    b!.append("Y");
    a!.receive(b!.take());
    b!.receive(a!.take());
    a!.receive(b!.take());
    b!.receive(a!.take());
    expect(texts(a!)).toBe("P! X Y Z");
    expect(texts(a!).endsWith("Z")).toBe(true);
    expect(texts(b!)).toBe(texts(a!));
  });

  test("a snapshot brings the places of a replica that crashed", () => {
    const json = genesis("x", "y");
    const [a, c] = peers(["a", "c"], json);
    const n = a!.append("n", a!.doc.root.first);
    a!.append("m", n);
    a!.get(a!.doc.root.last!.id).move(n, "before");
    a!.doc.forceCommit();
    a!.take();
    c!.receive([labelsSnapshot(a!.stored())]);
    const x = a!.doc.root.first!;
    expect(texts(c!)).toBe("x");
    expect(texts(c!, c!.get(x.id))).toBe("y n");
    // The same places: an insert next to them lands alike on both.
    c!.before(c!.get(n.id), "k");
    a!.receive(c!.take());
    expect(texts(a!, x)).toBe("y k n");
    expect(texts(c!, c!.get(x.id))).toBe(texts(a!, x));
  });
});

describe("stored labels and moves", () => {
  /** How many sessions the stored document's one table has. */
  const sessions = (replica: Replica) => replica.stored()[3]?.length ?? 0;

  test("labels add only the sessions of moves to the stored table", () => {
    const [a, b, c] = peers(["a", "b", "c"], genesis());
    a!.append("A");
    b!.append("B");
    c!.receive([...a!.take(), ...b!.take()]);
    expect(texts(c!)).toBe("A B");
    // The authors' sessions name the nodes: their labels share them.
    const before = sessions(c!);
    c!.get(c!.doc.root.first!.id).move(c!.doc.root.last!, "after");
    c!.doc.forceCommit();
    // The mover's: its stamp's, and its new place's (`c~`).
    expect(sessions(c!)).toBe(before + 2);
  });

  test("a node first moved by another replica keeps its back when stored", () => {
    const [a, b] = peers(["a", "b"], genesis("x", "y"));
    const x = a!.doc.root.first!.id;
    a!.get(x).move(a!.doc.root.last!, "after");
    a!.doc.forceCommit();
    b!.receive(a!.take());
    const reloaded = replica("b", b!.stored());
    expect(texts(reloaded)).toBe("y x");
    expect(reloaded.stored()).toStrictEqual(b!.stored());
  });
});
