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
  /** Terminal network actions leave a settled query untouched. */
  ignoredWhenSettled?: boolean;
};

const fetchStatuses = ["fetching", "paused", "idle"] satisfies FetchStatus[];
const localError = new Error("local failed");
const networkError = new Error("network failed");

function reducerFor(state: State) {
  return createQueryResultReducer<Data>({ initialState: state });
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

/**
 * Terminal network actions settle a query, but a query that went `paused` while
 * the response was in flight must stay `paused`.
 */
function terminalFetchStatus(state: State): FetchStatus {
  return state.fetchStatus === "paused" ? "paused" : "idle";
}

function networkDocNotFoundExpected(
  state: State,
  createIfMissing: boolean,
): State {
  const fetchStatus = terminalFetchStatus(state);
  if ("data" in state) return success(state.data, fetchStatus);
  if (createIfMissing) return { status: "pending", fetchStatus };
  return success(undefined, fetchStatus);
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
    expected: (state) =>
      state.status === "error"
        ? { ...state, data: "found" }
        : success("found", state.fetchStatus),
  },
  {
    name: "localQueryError",
    run: (state) =>
      reducerFor(state).action.localQueryError({ error: localError }),
    expected: (state) => errorState(state, state.fetchStatus, localError),
  },
  {
    name: "fetchStarted",
    run: (state) => reducerFor(state).action.fetchStarted(undefined),
    expected: (state) => withFetchStatus(state, "fetching"),
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
    expected: (state) => withFetchStatus(state, "paused"),
  },
  {
    name: "connectionError",
    run: (state) =>
      reducerFor(state).action.connectionError({ error: networkError }),
    expected: (state) => errorState(state, "paused", networkError),
  },
  {
    name: "networkDocFound",
    run: (state) =>
      reducerFor(state).action.networkDocFound({ data: "network" }),
    expected: (state) => success("network", terminalFetchStatus(state)),
    ignoredWhenSettled: true,
  },
  {
    name: "networkDocNotFound optional data",
    run: (state) =>
      reducerFor(state).action.networkDocNotFound({ createIfMissing: false }),
    expected: (state) => networkDocNotFoundExpected(state, false),
    ignoredWhenSettled: true,
  },
  {
    name: "networkDocNotFound required data",
    run: (state) =>
      reducerFor(state).action.networkDocNotFound({ createIfMissing: true }),
    expected: (state) => networkDocNotFoundExpected(state, true),
    ignoredWhenSettled: true,
  },
  {
    name: "networkQueryError",
    run: (state) =>
      reducerFor(state).action.networkQueryError({ error: networkError }),
    expected: (state) =>
      errorState(state, terminalFetchStatus(state), networkError),
    ignoredWhenSettled: true,
  },
];
