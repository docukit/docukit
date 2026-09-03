import { describe, expect, test } from "vitest";
import { actionCases, stateCases } from "./utils.js";

const combinations = stateCases.flatMap((stateCase) =>
  actionCases.map((actionCase) => ({ stateCase, actionCase })),
);

describe("createQueryResultReducer", () => {
  test("declares every state and action combination", () => {
    expect(combinations).toHaveLength(stateCases.length * actionCases.length);
  });

  test.each(combinations)(
    "$stateCase.name + $actionCase.name",
    ({ stateCase, actionCase }) => {
      // A settled query already holds the newest attempt's result, so a
      // terminal network action from a superseded attempt leaves it untouched.
      if (
        actionCase.ignoredWhenSettled &&
        stateCase.state.fetchStatus === "idle"
      ) {
        expect(actionCase.run(stateCase.state)).toBe(stateCase.state);
        return;
      }

      expect(actionCase.run(stateCase.state)).toStrictEqual(
        actionCase.expected(stateCase.state),
      );
    },
  );
});
