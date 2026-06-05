import {
  _INTERNAL_createQueryResultReducer as createQueryResultReducer,
  type FetchStatus,
  type QueryResult,
} from "@docukit/docsync/client";

type Data = string | undefined;
type State = QueryResult<Data>;

type StateCase = { name: string; state: State };

type ActionCase = {
  name: string;
  run: (state: State) => State;
  expected: (state: State) => State;
  invalid?: (state: State) => string | undefined;
};

const fetchStatuses = ["fetching", "paused", "idle"] satisfies FetchStatus[];
const localError = new Error("local failed");
const networkError = new Error("network failed");

function reducerFor(state: State, createIfMissing = false) {
  const reducer = createQueryResultReducer<Data>({
    initialFetchStatus: state.fetchStatus === "paused" ? "paused" : "fetching",
    createIfMissing,
  });
  Object.assign(reducer.getState(), state);
  return reducer;
}

function success(data: Data, fetchStatus: FetchStatus): State {
  return { status: "success", fetchStatus, data };
}

function pending(fetchStatus: FetchStatus): State {
  return { status: "pending", fetchStatus };
}

function errorWithoutData(fetchStatus: FetchStatus): State {
  return { status: "error", fetchStatus, error: localError };
}

function errorWithData(fetchStatus: FetchStatus): State {
  return { status: "error", fetchStatus, data: "local", error: localError };
}

function errorState(
  state: State,
  fetchStatus: FetchStatus,
  error: Error,
): State {
  return { ...state, status: "error", fetchStatus, error };
}

function withFetchStatus(state: State, fetchStatus: FetchStatus): State {
  if (state.fetchStatus === fetchStatus) return state;
  if (state.status === "pending") return { status: "pending", fetchStatus };
  if (state.status === "success") return success(state.data, fetchStatus);
  return errorState(state, fetchStatus, state.error);
}

function invalidNetworkAction(state: State): string | undefined {
  if (state.fetchStatus !== "idle") return undefined;
  return "when fetchStatus is idle";
}

function networkDocNotFoundExpected(
  state: State,
  createIfMissing: boolean,
): State {
  if ("data" in state) return success(state.data, "idle");
  if (createIfMissing) return { status: "pending", fetchStatus: "idle" };
  return success(undefined, "idle");
}

export const stateCases: StateCase[] = [
  ...fetchStatuses.map((fetchStatus) => ({
    name: `pending ${fetchStatus}`,
    state: pending(fetchStatus),
  })),
  ...fetchStatuses.map((fetchStatus) => ({
    name: `success with data ${fetchStatus}`,
    state: success("local", fetchStatus),
  })),
  ...fetchStatuses.map((fetchStatus) => ({
    name: `success with undefined ${fetchStatus}`,
    state: success(undefined, fetchStatus),
  })),
  ...fetchStatuses.map((fetchStatus) => ({
    name: `error without data ${fetchStatus}`,
    state: errorWithoutData(fetchStatus),
  })),
  ...fetchStatuses.map((fetchStatus) => ({
    name: `error with data ${fetchStatus}`,
    state: errorWithData(fetchStatus),
  })),
];

export const actionCases: ActionCase[] = [
  {
    name: "localDocFound",
    run: (state) => reducerFor(state).action.localDocFound({ data: "found" }),
    expected: (state) => success("found", state.fetchStatus),
  },
  {
    name: "localQueryError",
    run: (state) =>
      reducerFor(state).action.localQueryError({ error: localError }),
    expected: (state) => errorState(state, state.fetchStatus, localError),
  },
  {
    name: "connected",
    run: (state) => reducerFor(state).action.connected(undefined),
    expected: (state) =>
      state.fetchStatus === "paused"
        ? withFetchStatus(state, "fetching")
        : state,
  },
  {
    name: "disconnected",
    run: (state) => reducerFor(state).action.disconnected(undefined),
    expected: (state) =>
      state.fetchStatus === "fetching"
        ? withFetchStatus(state, "paused")
        : state,
  },
  {
    name: "networkDocFound",
    run: (state) =>
      reducerFor(state).action.networkDocFound({ data: "network" }),
    expected: () => success("network", "idle"),
    invalid: invalidNetworkAction,
  },
  {
    name: "networkDocNotFound optional data",
    run: (state) => reducerFor(state).action.networkDocNotFound(undefined),
    expected: (state) => networkDocNotFoundExpected(state, false),
    invalid: invalidNetworkAction,
  },
  {
    name: "networkDocNotFound required data",
    run: (state) =>
      reducerFor(state, true).action.networkDocNotFound(undefined),
    expected: (state) => networkDocNotFoundExpected(state, true),
    invalid: invalidNetworkAction,
  },
  {
    name: "networkQueryError",
    run: (state) =>
      reducerFor(state).action.networkQueryError({ error: networkError }),
    expected: (state) => errorState(state, "idle", networkError),
    invalid: invalidNetworkAction,
  },
];
