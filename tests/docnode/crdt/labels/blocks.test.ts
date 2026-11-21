import { describe, expect, test } from "vitest";
import { backspaceJoin } from "../../text/utils.js";
import { exchange, textPair } from "./utils.js";

describe("text blocks", () => {
  test.each([true, false])(
    "Backspace-join racing a move of the joined paragraph leaves no empty one (A first: %s)",
    (aFirst) => {
      const { a, b } = textPair(["one", "two", "three"]);
      backspaceJoin(a.find("two"), a.find("three"));
      b.find("three").move(b.find("one"), "before");
      exchange(a, b, aFirst);
      expect(a.texts()).toStrictEqual(["one", "twothree"]);
      expect(b.texts()).toStrictEqual(a.texts());
    },
  );
});
