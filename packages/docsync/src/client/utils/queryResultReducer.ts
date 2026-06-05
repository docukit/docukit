import type { FetchStatus, QueryResult } from "../types.js";
import { createReducer } from "./reducer.js";

function withFetchStatus<D>(
  state: QueryResult<D>,
  fetchStatus: FetchStatus,
): QueryResult<D> {
  if (state.fetchStatus === fetchStatus) return state;
  return { ...state, fetchStatus };
}

function success<D>(data: D, fetchStatus: FetchStatus): QueryResult<D> {
  return { status: "success", fetchStatus, data };
}

function error<D>(
  state: QueryResult<D>,
  fetchStatus: FetchStatus,
  errorValue: Error,
): QueryResult<D> {
  return { ...state, status: "error", fetchStatus, error: errorValue };
}

/**
 * @internal - Do not use this function!
 */
export function createQueryResultReducer<D>(config: {
  initialFetchStatus: FetchStatus;
  createIfMissing: boolean;
}) {
  const initialState: QueryResult<D> = {
    status: "pending",
    fetchStatus: config.initialFetchStatus,
  };

  const actions = {
    // localDocNotFound is not an action, because does not change the state
    localDocFound: (state: QueryResult<D>, payload: { data: D }) =>
      success(payload.data, state.fetchStatus),

    localQueryError: (state: QueryResult<D>, payload: { error: Error }) =>
      error(state, state.fetchStatus, payload.error),

    connected: (state: QueryResult<D>, _payload: undefined) => {
      if (state.fetchStatus !== "paused") return state;
      return withFetchStatus(state, "fetching");
    },

    disconnected: (state: QueryResult<D>, _payload: undefined) => {
      if (state.fetchStatus !== "fetching") return state;
      return withFetchStatus(state, "paused");
    },

    networkDocFound: (_state: QueryResult<D>, payload: { data: D }) =>
      success(payload.data, "idle"),

    networkDocNotFound: (
      state: QueryResult<D>,
      _payload: undefined,
    ): QueryResult<D> => {
      if (state.status === "success") return success(state.data, "idle");
      if (state.status === "error" && state.data !== undefined) {
        return success(state.data, "idle");
      }
      if (config.createIfMissing) {
        return { status: "pending", fetchStatus: "idle" };
      }
      return success(undefined as D, "idle");
    },

    networkQueryError: (state: QueryResult<D>, payload: { error: Error }) =>
      error(state, "idle", payload.error),
  };

  return createReducer<QueryResult<D>, typeof actions>({
    initialState,
    actions,
    beforeAction: (state, action) => {
      const terminalNetworkAction =
        action.type === "networkDocFound" ||
        action.type === "networkDocNotFound" ||
        action.type === "networkQueryError";

      if (terminalNetworkAction && state.fetchStatus === "idle") {
        throw new Error(`Cannot apply ${action.type} when fetchStatus is idle`);
      }
    },
  });
}
