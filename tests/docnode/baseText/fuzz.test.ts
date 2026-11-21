import type { Json } from "@docukit/docnode";
import { expect, test } from "vitest";

import { randomizer, type Randomizer } from "../text/utils.js";
import { Network, P, reload, rootText, stored, type Text } from "./utils.js";

const SEEDS = Number(process.env.BASE_TEXT_FUZZ_SEEDS ?? 100);
const WORDS = ["a", "bc", "def", "hello ", " ", "😀", "xy", `p${P}q`];
const STATES: (Record<string, Json> | undefined)[] = [
  undefined,
  undefined,
  {},
  { bold: true },
  { link: "u" },
  { italic: 1, bold: null },
];

/** One random edit of the root text: typing, Enter, Backspace, formats, moves. */
function edit(text: Text, rng: Randomizer) {
  const length = text.length;
  const at = rng.int(length + 1);
  const roll = rng.next();
  if (roll < 0.4) text.insert(at, rng.pick(WORDS), rng.pick(STATES));
  else if (roll < 0.55) text.delete(at, 1 + rng.int(5));
  else if (roll < 0.7)
    text.format(
      at,
      at + 1 + rng.int(6),
      rng.pick(["bold", "italic", "link"]),
      rng.next() < 0.75 ? rng.pick([true, "x", 3]) : null,
    );
  else if (roll < 0.8) text.insert(at, P, rng.next() < 0.3 ? { h: 1 } : {});
  else if (roll < 0.9) {
    // Backspace at the start of a line: its paragraph letter goes.
    const end = text.get().indexOf(P, at);
    if (end !== -1) text.delete(end, 1);
  } else {
    // A line moves: deleted, and its letters inserted elsewhere.
    const plain = text.get();
    const start = plain.lastIndexOf(P, at - 1) + 1;
    const end = plain.indexOf(P, start);
    if (end === -1) return;
    const pieces: { text: string; attrs: Record<string, Json> }[] = [];
    let cursor = 0;
    for (const span of text.spans()) {
      const from = Math.max(start, cursor);
      const to = Math.min(end + 1, cursor + span.text.length);
      if (to > from)
        pieces.push({
          text: span.text.slice(from - cursor, to - cursor),
          attrs: span.attrs,
        });
      cursor += span.text.length;
    }
    text.delete(start, end + 1 - start);
    let target = rng.int(text.length + 1);
    for (const piece of pieces) {
      text.insert(target, piece.text, piece.attrs);
      target += piece.text.length;
    }
  }
}

function history(seed: number) {
  const rng = randomizer(seed);
  const network = new Network(`one${P}two${P}three${P}`, ["a", "b", "c"]);
  for (let step = 0; step < 150; step++) {
    const session = rng.pick(network.sessions);
    const roll = rng.next();
    if (roll < 0.5)
      network.edit(session, (text) => {
        for (let count = 1 + rng.int(3); count > 0; count--) edit(text, rng);
      });
    else if (roll < 0.58) network.undo(session);
    else if (roll < 0.62) network.redo(session);
    else if (roll < 0.66) network.reload(session);
    else if (roll < 0.83)
      network.send(session, {
        merge: rng.next() < 0.5,
        twice: rng.next() < 0.1,
      });
    else network.sync(session);
  }
  network.exchange();
  network.exchange();
  return network;
}

test(
  `${SEEDS} histories in the server's order converge, also reloaded`,
  { timeout: Math.max(8000, SEEDS * 20) },
  () => {
    const first = Number(process.env.BASE_TEXT_FUZZ_FROM ?? 1);
    for (let seed = first; seed < first + SEEDS; seed++) {
      const network = history(seed);
      expect(() => network.converged(), `seed ${seed}`).not.toThrow();
      const spans = network.converged();
      expect(rootText(reload(network.server)).spans()).toStrictEqual(spans);
      expect(stored(reload(network.server))).toBe(stored(network.server));
    }
  },
);
