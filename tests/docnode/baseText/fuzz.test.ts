import { expect, test } from "vitest";

import { randomizer, type Randomizer } from "../text/utils.js";
import { Network, P, reload, rootText, stored, type Text } from "./utils.js";

const SEEDS = Number(process.env.BASE_TEXT_FUZZ_SEEDS ?? 100);
const WORDS = ["a", "bc", "def", "hello ", " ", "😀", "xy", `p${P}q`];
/** One random edit of the root text: typing, Enter, Backspace, moves. */
function edit(text: Text, rng: Randomizer) {
  const length = text.length;
  const at = rng.int(length + 1);
  const roll = rng.next();
  if (roll < 0.45) text.insert(at, rng.pick(WORDS));
  else if (roll < 0.65) text.delete(at, 1 + rng.int(5));
  else if (roll < 0.8) text.insert(at, P);
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
    text.delete(start, end + 1 - start);
    text.insert(rng.int(text.length + 1), plain.slice(start, end + 1));
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
      const text = network.converged();
      expect(rootText(reload(network.server)).get()).toBe(text);
      expect(stored(reload(network.server))).toBe(stored(network.server));
    }
  },
);
