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
      const invalidReason = actionCase.invalid?.(stateCase.state);

      if (invalidReason) {
        expect(() => actionCase.run(stateCase.state)).toThrow(invalidReason);
        return;
      }

      expect(actionCase.run(stateCase.state)).toStrictEqual(
        actionCase.expected(stateCase.state),
      );
    },
  );
});
