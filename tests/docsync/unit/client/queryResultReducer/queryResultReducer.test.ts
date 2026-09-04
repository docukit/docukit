import { describe, expect, test } from "vitest";
import { actionCases, stateCases } from "./utils.js";

const combinations = stateCases.flatMap((stateCase) =>
  actionCases.map((actionCase) => ({ stateCase, actionCase })),
);

describe("createQueryResultReducer", () => {
  test.each(combinations)(
    "$stateCase.name + $actionCase.name",
    ({ stateCase, actionCase }) => {
      const next = actionCase.run(stateCase.state);
      expect(next).toStrictEqual(actionCase.expected(stateCase.state));

      // A sync that only confirms what the query already holds must return the
      // very same object. Reporting an equal-but-new result would re-render
      // every `useDoc` consumer on every background sync, which is the whole
      // reason `fetchStatus` no longer tracks routine pushes.
      if (
        actionCase.unchangedWhenConfirming &&
        stateCase.state.status === "success" &&
        stateCase.state.fetchStatus !== "fetching"
      ) {
        expect(next).toBe(stateCase.state);
      }
    },
  );
});
