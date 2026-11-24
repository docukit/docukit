import { rebase, type Doc, type Json, type Operations } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import { randomizer, type Randomizer } from "../text/utils.js";
import {
  flat,
  P,
  receive,
  reload,
  rootText,
  sent,
  stored,
  styled,
  type Text,
} from "./utils.js";

const SEEDS = Number(process.env.REBASE_TEXT_SEEDS ?? 100);
const WORDS = ["a", "bc", "def", " ", "😀", `p${P}q`];
const STATES: (Record<string, Json> | undefined)[] = [
  undefined,
  { bold: true },
  { link: "u" },
  { italic: 1, bold: null },
];

/** One random edit of the root text: typing, Enter, Backspace or a format. */
function edit(text: Text, rng: Randomizer) {
  const at = rng.int(text.length + 1);
  const roll = rng.next();
  if (roll < 0.4) text.insert(at, rng.pick(WORDS), rng.pick(STATES));
  else if (roll < 0.7) text.delete(at, 1 + rng.int(5));
  else
    text.format(
      at,
      at + 1 + rng.int(6),
      rng.pick(["bold", "italic", "link"]),
      rng.next() < 0.75 ? rng.pick([true, "x", 3]) : null,
    );
}

/** Two replicas of a server whose text is `text`: `mine` rebases in place. */
function replicas(text: string) {
  const server = flat(text, "s").doc;
  const mine = reload(server, "m");
  rebase(mine);
  return { server, mine, peer: reload(server, "p") };
}

/**
 * The server orders `remote` and then `pending`, which `mine` has applied
 * already: it rebases, and must store what the server does.
 */
function order(
  server: Doc,
  mine: Doc,
  remote: Operations[],
  pending: Operations[],
) {
  receive(server, ...remote, ...pending);
  expect(rebase(mine, remote)).toBe(true);
  receive(mine, ...pending);
  expect(stored(mine)).toBe(stored(server));
  expect(rootText(mine).spans()).toStrictEqual(rootText(server).spans());
}

describe("rebase of the text", () => {
  test(
    `${SEEDS} histories: undoing one transaction stores what it stored before`,
    { timeout: Math.max(8000, SEEDS * 20) },
    () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = randomizer(seed);
        const { doc } = flat(`one${P}two${P}three${P}`, "s");
        rebase(doc);
        for (let step = 0; step < 40; step++) {
          const before = stored(doc);
          const roll = rng.next();
          const batches = sent(doc, () => {
            if (roll < 0.15) doc.undoManager.undo();
            else if (roll < 0.2) doc.undoManager.redo();
            else
              for (let count = 1 + rng.int(3); count > 0; count--)
                edit(rootText(doc), rng);
          });
          const after = stored(doc);
          rebase(doc, []);
          expect(stored(doc), `seed ${seed} step ${step}`).toBe(before);
          rebase(doc, batches);
          expect(stored(doc), `seed ${seed} step ${step}`).toBe(after);
        }
      }
    },
  );

  test("a format gives back each letter the value it had", () => {
    // `a` and `b` have ids one after the other, and a peer's bold `X` is
    // between them: its old value is not theirs.
    const { server, peer } = replicas("ab");
    const typed = sent(peer, () =>
      rootText(peer).insert(1, "X", { bold: true }),
    );
    receive(server, ...typed);
    const mine = reload(server, "m");
    rebase(mine);
    const pending = sent(mine, () => rootText(mine).format(0, 3, "bold", 3));
    const remote = sent(peer, () => rootText(peer).insert(3, "!"));
    order(server, mine, remote, pending);
    // `!`, typed right after `b` with its old value, takes it too.
    expect(styled(rootText(mine).spans())).toStrictEqual(['aXb!:{"bold":3}']);
  });

  test("letters a delete took apart go back each to its place", () => {
    const { server, mine, peer } = replicas("abcd");
    // The server puts the peer's `X` inside what `mine` deletes.
    const pending = sent(mine, () => rootText(mine).delete(0, 3));
    const inside = sent(peer, () => rootText(peer).insert(1, "X"));
    order(server, mine, inside, pending);
    expect(rootText(mine).get()).toBe("Xd");
    // The delete applied again took `a`, then `bc`: undone, `a`, `X`, `bc`,
    // where the peer types after `c`.
    const afterC = sent(peer, () => rootText(peer).insert(4, "!"));
    order(server, mine, afterC, pending);
    expect(rootText(mine).get()).toBe("X!d");
  });

  test("ghosts that moved with a deleted letter go back to it", () => {
    const { server, mine, peer } = replicas("abc");
    // `b` leaves a ghost at `a`; deleting `a` moves it to the start.
    const pending = [
      ...sent(mine, () => rootText(mine).delete(1, 1)),
      ...sent(mine, () => rootText(mine).delete(0, 1)),
    ];
    // Typed right after `b`, which the server still has.
    const after = sent(peer, () => rootText(peer).insert(2, "Y"));
    order(server, mine, after, pending);
    expect(rootText(mine).get()).toBe("Yc");
  });

  test("a document loaded again cannot, until it rebases from the server's", () => {
    const { server, mine, peer } = replicas("ab");
    const pending = sent(mine, () => rootText(mine).insert(2, "!"));
    const copy = reload(mine, "m2");
    const remote = sent(peer, () => rootText(peer).insert(0, ">"));
    expect(rebase(copy, remote)).toBe(false);
    expect(rootText(copy).get()).toBe("ab!");
    order(server, mine, remote, pending);
  });
});
