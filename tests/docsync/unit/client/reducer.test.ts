import { describe, expect, test } from "vitest";
import { _INTERNAL_createReducer as createReducer } from "@docukit/docsync/client";

type State = { count: number };

describe("createReducer", () => {
  test("runs typed actions and stores the latest state", () => {
    const beforeActions: Array<{
      state: State;
      action: { type: "add"; payload: { amount: number } };
    }> = [];

    const reducer = createReducer({
      initialState: { count: 0 },
      actions: {
        add: (state, payload: { amount: number }) => ({
          count: state.count + payload.amount,
        }),
      },
      beforeAction: (state, action) => {
        beforeActions.push({ state, action });
      },
    });

    expect(reducer.action.add({ amount: 2 })).toStrictEqual({ count: 2 });
    expect(reducer.getState()).toStrictEqual({ count: 2 });
    expect(beforeActions).toStrictEqual([
      { state: { count: 0 }, action: { type: "add", payload: { amount: 2 } } },
    ]);
  });
});
