import { mergeOperations } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import {
  assertWellFormed,
  Cluster,
  orderedCluster,
  Paragraph,
  paragraphs,
  permutations,
  randomizer,
  runsOf,
  type Entry,
} from "./utils.js";

/** Applies the entries to every replica in every permutation; asserts convergence. */
function everyOrder(
  cluster: Cluster,
  entries: Entry[],
  check: (cluster: Cluster, replica: number) => void,
) {
  // Replays the same entries on a fresh replica in each order.
  for (const order of permutations(entries)) {
    const fresh = Cluster.replicate(cluster);
    for (const entry of order)
      fresh.applyOperations(entry.operations, { skipUndo: true });
    fresh.forceCommit();
    const copy = new Cluster([], 0);
    copy.docs.push(fresh);
    check(copy, 0);
  }
}

const twoReplicaRace = (
  paragraph: string,
  a: (c: Cluster) => void,
  b: (c: Cluster) => void,
) => {
  const cluster = new Cluster([paragraph], 2);
  a(cluster);
  b(cluster);
  cluster.deliverAll();
  cluster.assertConverged();
  return cluster;
};

describe("cat dog with a full copy pasted next to it", () => {
  test("copy prepended: the insertion stays in the original", () => {
    const cluster = twoReplicaRace(
      "cat dog",
      (c) => c.edit(0, () => c.node(0, c.ids[0]!).state.t.insert(0, "cat dog")),
      (c) => c.edit(1, () => c.node(1, c.ids[0]!).state.t.insert(3, "X")),
    );
    expect(cluster.texts(0)).toStrictEqual(["cat dogcatX dog"]);
  });

  test("copy appended: the insertion stays in the original", () => {
    const cluster = twoReplicaRace(
      "cat dog",
      (c) => c.edit(0, () => c.node(0, c.ids[0]!).state.t.insert(7, "cat dog")),
      (c) => c.edit(1, () => c.node(1, c.ids[0]!).state.t.insert(3, "X")),
    );
    expect(cluster.texts(0)).toStrictEqual(["catX dogcat dog"]);
  });
});

describe("applySpans with repeated text", () => {
  const plain = (text: string) => [{ text, attrs: {} }];

  test("the caret anchors a pasted copy before the original", () => {
    const cluster = twoReplicaRace(
      "cat dog",
      (c) =>
        c.edit(0, () =>
          c.node(0, c.ids[0]!).state.t.applySpans(plain("cat dog cat dog"), 8),
        ),
      (c) => c.edit(1, () => c.node(1, c.ids[0]!).state.t.insert(3, " X")),
    );
    expect(cluster.texts(0)).toStrictEqual(["cat dog cat X dog"]);
  });

  test("without a caret the copy goes after the original", () => {
    const cluster = twoReplicaRace(
      "cat dog",
      (c) =>
        c.edit(0, () =>
          c.node(0, c.ids[0]!).state.t.applySpans(plain("cat dog cat dog")),
        ),
      (c) => c.edit(1, () => c.node(1, c.ids[0]!).state.t.insert(3, " X")),
    );
    expect(cluster.texts(0)).toStrictEqual(["cat X dog cat dog"]);
  });

  test("a row added before identical rows keeps a peer's edit in its row", () => {
    const cluster = twoReplicaRace(
      "item; item; ",
      (c) =>
        c.edit(0, () =>
          c
            .node(0, c.ids[0]!)
            .state.t.applySpans(plain("item; item; item; "), 6),
        ),
      (c) => c.edit(1, () => c.node(1, c.ids[0]!).state.t.insert(10, "!")),
    );
    expect(cluster.texts(0)).toStrictEqual(["item; item; item!; "]);
  });

  test("deleting one of two identical rows deletes the one under the caret", () => {
    const cluster = twoReplicaRace(
      "item; item; ",
      (c) =>
        c.edit(0, () =>
          c.node(0, c.ids[0]!).state.t.applySpans(plain("item; "), 0),
        ),
      (c) => c.edit(1, () => c.node(1, c.ids[0]!).state.t.insert(10, "!")),
    );
    expect(cluster.texts(0)).toStrictEqual(["item!; "]);
  });

  test("a caret outside the possible places is clamped", () => {
    const { nodes } = paragraphs(["aaaa"]);
    const t = nodes[0]!.state.t;
    t.applySpans(plain("aaaaa"), 99);
    t.applySpans(plain("aaa"), -5);
    expect(t.get()).toBe("aaa");
  });

  test("a caret that would split a surrogate pair is ignored", () => {
    const { nodes } = paragraphs(["😀😀"]);
    const t = nodes[0]!.state.t;
    t.applySpans(plain("😀😀😀"), 3);
    t.applySpans(plain("😀😀"), 1);
    expect(t.get()).toBe("😀😀");
  });
});

describe("the Attiya abc example", () => {
  test("q stays before p whatever arrives first", () => {
    const cluster = new Cluster(["abc"], 3);
    const id = cluster.ids[0]!;
    const entries: Entry[] = [
      ...cluster.edit(0, () => cluster.node(0, id).state.t.delete(0, 1)),
      ...cluster.edit(1, () => cluster.node(1, id).state.t.insert(1, "p")),
      ...cluster.edit(2, () => cluster.node(2, id).state.t.insert(0, "q")),
    ];
    everyOrder(cluster, entries, (result) => {
      expect(result.docs[0]!.getNodeById(id)!.is(Paragraph)).toBe(true);
      expect(result.texts(0)[0]).toBe("qpbc");
    });
  });
});

describe("an insert whose origins are no longer neighbours", () => {
  test("a letter typed after one a peer typed on from goes among its kids", () => {
    // On replica 0, "a" and the "b" typed after it are one run. Replica 1
    // typed X after "a" before it had "b": X's right origin is the end, not
    // "b", so X does not simply go between them.
    const cluster = orderedCluster([""], 2);
    const id = cluster.ids[0]!;
    const text = (replica: number) => cluster.node(replica, id).state.t;
    cluster.edit(0, () => text(0).insert(0, "a"));
    cluster.deliverAll();
    cluster.edit(0, () => text(0).insert(1, "b"));
    cluster.edit(1, () => text(1).insert(1, "X"));
    expect(runsOf(cluster.docs[0]!)).toStrictEqual([["ab"]]);
    cluster.deliverAll();
    cluster.assertConverged();
    // Two right children of "a" with the same right origin: by session.
    expect(cluster.text(0, id)).toBe("abX");
  });
});

describe("identical repeated rows", () => {
  test("each row edit lands in its own row", () => {
    const cluster = new Cluster(["row\nrow\nrow\nrow"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(11, "X"));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(4, "Y"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("row\nYrow\nrowX\nrow");
  });
});

describe("typing backwards on three replicas", () => {
  test("each backward run stays contiguous", () => {
    const cluster = new Cluster(["ab"], 3);
    const id = cluster.ids[0]!;
    const words = ["cba", "fed", "ihg"];
    for (const [replica, word] of words.entries()) {
      // Types the word back to front at the same position.
      for (const letter of word) {
        cluster.edit(replica, () =>
          cluster.node(replica, id).state.t.insert(1, letter),
        );
      }
    }
    cluster.deliverAll(randomizer(3));
    cluster.assertConverged();
    const text = cluster.text(0, id);
    expect(text).toHaveLength(11);
    for (const word of ["abc", "def", "ghi"]) expect(text).toContain(word);
    expect(text.startsWith("a")).toBe(true);
    expect(text.endsWith("b")).toBe(true);
  });
});

describe("typing at the exact edge of a link", () => {
  test("text typed at both edges stays outside the link", () => {
    const cluster = new Cluster(["see link here"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(4, 8, "link", "https://a"),
    );
    cluster.deliverAll();
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(8, "A"));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(4, "B"));
    cluster.deliverAll();
    cluster.assertConverged();
    const spans = cluster.spans(0, id);
    expect(
      spans.map((span) => [span.text, span.attrs.link ?? null]),
    ).toStrictEqual([
      ["see B", null],
      ["link", "https://a"],
      ["A here", null],
    ]);
  });

  test("the link keeps its span when a peer formats concurrently", () => {
    const cluster = new Cluster(["see link here"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(4, 8, "link", "https://a"),
    );
    cluster.edit(1, () =>
      cluster.node(1, id).state.t.format(0, 13, "bold", true),
    );
    cluster.deliverAll();
    cluster.assertConverged();
    const spans = cluster.spans(0, id);
    expect(spans).toStrictEqual([
      { text: "see ", attrs: { bold: true } },
      { text: "link", attrs: { bold: true, link: "https://a" } },
      { text: " here", attrs: { bold: true } },
    ]);
  });
});

describe("overlapping bold and unbold", () => {
  test("converges and only the overlap depends on the tie-break", () => {
    const cluster = new Cluster(["hello world"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 11, "bold", true),
    );
    cluster.deliverAll();
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 5, "italic", true),
    );
    cluster.edit(1, () =>
      cluster.node(1, id).state.t.format(3, 8, "bold", null),
    );
    cluster.deliverAll(randomizer(5));
    cluster.assertConverged();
    const boldByChar = cluster
      .spans(0, id)
      .flatMap((span) => Array.from(span.text, () => span.attrs.bold === true));
    // Characters only the other peer's unbold touched lose the bold: 0..3 keep it, 8.. keep it.
    expect(boldByChar.slice(0, 3)).toStrictEqual([true, true, true]);
    expect(boldByChar.slice(3, 8)).toStrictEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(boldByChar.slice(8)).toStrictEqual([true, true, true]);
  });

  test("Peritext example: overlapping bolds do not cut each other", () => {
    const cluster = new Cluster(["The fox jumped."], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 7, "bold", true),
    );
    cluster.edit(1, () =>
      cluster.node(1, id).state.t.format(4, 15, "bold", true),
    );
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(0, id)).toStrictEqual([
      { text: "The fox jumped.", attrs: { bold: true } },
    ]);
  });
});

describe("emoji and other surrogate pairs", () => {
  test("concurrent edits around emoji never split a pair", () => {
    const cluster = new Cluster(["a😀b👩‍🚀c"], 3);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(1, 2));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(3, "X"));
    cluster.edit(2, () => cluster.node(2, id).state.t.insert(1, "😎"));
    cluster.deliverAll(randomizer(9));
    cluster.assertConverged();
    assertWellFormed(cluster.text(0, id));
  });

  test("a split position inside a pair snaps to a character boundary", () => {
    const cluster = new Cluster(["a😀b"], 1);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(2, "X"));
    assertWellFormed(cluster.text(0, id));
    expect(cluster.text(0, id)).toBe("a😀Xb");
  });
});

/** A flat text: a paragraph is a line ended by this letter. */
const P = "\x7f";

describe("Enter and Backspace in a flat text", () => {
  const lines = (cluster: Cluster) => cluster.texts(0)[0]!.split(P);

  test("two Enters at the same place leave one extra empty line", () => {
    const cluster = new Cluster([`Hello world${P}`], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(6, P));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(6, P));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(lines(cluster)).toStrictEqual(["Hello ", "", "world", ""]);
  });

  test("Enter while a peer types in the tail of that line", () => {
    const cluster = new Cluster([`Hello world${P}`], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(6, P));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(8, "X"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(lines(cluster)).toStrictEqual(["Hello ", "woXrld", ""]);
  });

  // Unlike a marker, the paragraph letter is a letter like any other: text
  // typed at the exact cut lands on either side, by the tie-break of ids.
  test("text typed at the exact cut lands on one side, the same everywhere", () => {
    const cluster = new Cluster([`Hello world${P}`], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(6, P));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(6, "NEW"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect([
      ["Hello NEW", "world", ""],
      ["Hello ", "NEWworld", ""],
    ]).toContainEqual(lines(cluster));
  });

  test("Backspace join while a peer types in the second line", () => {
    const cluster = new Cluster([`First${P}Second line.${P}`], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(5, 1));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(13, "really "));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(lines(cluster)).toStrictEqual(["FirstSecond really line.", ""]);
  });

  test("Backspace join after a previous Enter", () => {
    const cluster = new Cluster([`Hello world${P}`], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(6, P));
    cluster.deliverAll();
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(6, 1));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(9, "X"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(lines(cluster)).toStrictEqual(["Hello woXrld", ""]);
  });

  test("a heading set on a line while a peer joins it keeps neither", () => {
    const cluster = new Cluster([`A${P}B${P}`], 2);
    const id = cluster.ids[0]!;
    // The block of the first line is the state of its paragraph letter.
    cluster.edit(0, () => cluster.node(0, id).state.t.format(1, 2, "T", "h1"));
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(1, 1));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(0, id)).toStrictEqual([{ text: `AB${P}`, attrs: {} }]);
  });
});

describe("a peer offline for a very long time", () => {
  test("its edit keeps its place after many remote edits", () => {
    const cluster = new Cluster(
      ["The quick brown fox jumps over the lazy dog."],
      3,
    );
    const id = cluster.ids[0]!;
    // Replica 2 is offline: it edits "lazy" and only syncs at the end.
    cluster.edit(2, () => cluster.node(2, id).state.t.insert(35, "very "));
    for (let edit = 0; edit < 500; edit++) {
      const replica = edit % 2;
      cluster.edit(replica, () => {
        const text = cluster.node(replica, id).state.t;
        if (edit % 5 === 0) text.delete(1, 1);
        else text.insert(1, "x");
      });
      cluster.deliver(cluster.log.at(-1)!, replica === 0 ? 1 : 0);
    }
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toContain("very lazy dog.");
  });
});

describe("delivery guarantees", () => {
  test("a fused run lands on top of a prefix the replica already saw", () => {
    const cluster = new Cluster(["hello"], 2);
    const id = cluster.ids[0]!;
    const typed = [" ", "w", "o"].map((letter, index) => {
      const [entry] = cluster.edit(0, () =>
        cluster.node(0, id).state.t.insert(5 + index, letter),
      );
      return entry!;
    });
    const fused = mergeOperations(...typed.map((entry) => entry.operations));
    // One insert of the three letters: a batch of one row has no brackets.
    expect(fused[1]).toBe(" wo");
    cluster.deliver(typed[0]!, 1);
    cluster.docs[1]!.applyOperations(fused, { skipUndo: true });
    cluster.docs[1]!.forceCommit();
    expect(cluster.text(1, id)).toBe("hello wo");
    const before = cluster.stateJson(1);
    cluster.docs[1]!.applyOperations(fused, { skipUndo: true });
    cluster.docs[1]!.forceCommit();
    expect(cluster.stateJson(1)).toBe(before);
    expect(cluster.stateJson(1)).toBe(cluster.stateJson(0));
  });

  test("the same operation delivered twice changes nothing", () => {
    const cluster = new Cluster(["hello"], 2);
    const id = cluster.ids[0]!;
    const [entry] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.insert(5, " world"),
    );
    cluster.deliver(entry!, 1, 2);
    expect(cluster.text(1, id)).toBe("hello world");
    const before = cluster.stateJson(1);
    cluster.deliver(entry!, 1, 2);
    expect(cluster.stateJson(1)).toBe(before);
  });

  test("a delete delivered before the insert it targets", () => {
    const cluster = new Cluster(["ab"], 3);
    const id = cluster.ids[0]!;
    const [insert] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.insert(1, "X"),
    );
    cluster.deliver(insert!, 1);
    const [remove] = cluster.edit(1, () =>
      cluster.node(1, id).state.t.delete(1, 1),
    );
    // Replica 2 gets the delete first, then the insert.
    cluster.deliver(remove!, 2);
    expect(cluster.text(2, id)).toBe("ab");
    cluster.deliver(insert!, 2);
    expect(cluster.text(2, id)).toBe("ab");
    cluster.deliverAll();
    cluster.assertConverged();
  });

  test("operations delivered in different orders converge", () => {
    const cluster = new Cluster(["start text"], 3);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(5, "A"));
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(2, 3));
    cluster.edit(2, () =>
      cluster.node(2, id).state.t.format(0, 4, "bold", true),
    );
    cluster.deliverAll(randomizer(21));
    cluster.assertConverged();
  });
});

describe("undo reverts only the user's own edits", () => {
  test("undoing an insert keeps what a peer typed around it", () => {
    const cluster = new Cluster(["ab"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(1, "XY"));
    cluster.deliverAll();
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(2, "Z"));
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("aZb");
  });

  test("undoing a delete restores the text at its original place", () => {
    const cluster = new Cluster(["abcd"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(1, 2));
    cluster.deliverAll();
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(1, "Z"));
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("aZbcd");
  });

  test("undo of a link removes the link and keeps a peer's typing inside it", () => {
    const cluster = new Cluster(["Revenue grew 4% in Q3."], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(8, 15, "link", "https://x"),
    );
    cluster.deliverAll();
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(13, "by "));
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(0, id)).toStrictEqual([
      { text: "Revenue grew by 4% in Q3.", attrs: {} },
    ]);
  });
});
