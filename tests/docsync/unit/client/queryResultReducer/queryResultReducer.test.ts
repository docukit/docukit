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
      // A settled query already has the result of a newer sync, so a terminal
      // network action from a superseded attempt must leave it untouched.
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
