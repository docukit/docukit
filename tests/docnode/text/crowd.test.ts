import { describe, expect, test } from "vitest";

import { crowdTyping, randomizer, textAfter } from "./utils.js";

/** What 40 replicas typing at once (seed 7, 5 rounds) always gave. */
const EXPECTED =
  "sgtafikbwbxzagqjiudhhldfnomxsmcoyztluqvqxdwazlnemjaepghmeislakcmnotzbfxghyccfghxihkmmraidnvnqwwbbogdwnrlttiujeiujjnzehkkkfykcdppvcyccfdhfbvvfgbbeelscmhdfegl";

describe("many letters typed at once in the same place", () => {
  const cluster = crowdTyping(7, 40, 5);

  test("every order of arrival gives the same text as always", () => {
    const rng = randomizer(11);
    expect(textAfter(cluster, cluster.log)).toBe(EXPECTED);
    for (let order = 0; order < 6; order++)
      expect(textAfter(cluster, rng.shuffle(cluster.log))).toBe(EXPECTED);
  });

  test("the replicas that typed it converge on it", () => {
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, cluster.ids[0]!)).toBe(EXPECTED);
  });
});
