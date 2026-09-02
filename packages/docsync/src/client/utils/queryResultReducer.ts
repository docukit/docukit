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
 * Terminal network actions settle the query, but they must not claim the
 * connection is healthy. The socket can drop while a response is still being
 * reconciled, so a query that is already `paused` stays `paused` and the app
 * keeps rendering its offline state.
 */
function terminalFetchStatus<D>(state: QueryResult<D>): FetchStatus {
  return state.fetchStatus === "paused" ? "paused" : "idle";
}

/**
 * @internal - Do not use this function!
 */
export function createQueryResultReducer<D>(config: {
  initialState: QueryResult<D>;
}) {
  return createReducer({
    initialState: config.initialState,
    actions: {
      // localDocNotFound is not an action, because does not change the state
      localDocFound: (state: QueryResult<D>, payload: { data: D }) =>
        state.status === "error"
          ? { ...state, data: payload.data }
          : success(payload.data, state.fetchStatus),

      localQueryError: (state: QueryResult<D>, payload: { error: Error }) =>
        error(state, terminalFetchStatus(state), payload.error),

      fetchStarted: (state: QueryResult<D>, _payload: undefined) =>
        withFetchStatus(state, "fetching"),

      connected: (state: QueryResult<D>, _payload: undefined) => {
        if (state.fetchStatus !== "paused") return state;
        return withFetchStatus(state, "fetching");
      },

      disconnected: (state: QueryResult<D>, _payload: undefined) => {
        if (state.fetchStatus === "paused") return state;
        return withFetchStatus(state, "paused");
      },

      /**
       * A permanent connection failure: the query cannot progress until the
       * client reconnects, so it pauses and surfaces the error in one step.
       */
      connectionError: (state: QueryResult<D>, payload: { error: Error }) =>
        error(state, "paused", payload.error),

      networkDocFound: (state: QueryResult<D>, payload: { data: D }) =>
        success(payload.data, terminalFetchStatus(state)),

      networkDocNotFound: (
        state: QueryResult<D>,
        payload: { createIfMissing: boolean },
      ): QueryResult<D> => {
        const fetchStatus = terminalFetchStatus(state);
        if (state.status === "success") return success(state.data, fetchStatus);
        if (state.status === "error" && state.data !== undefined) {
          return success(state.data, fetchStatus);
        }
        if (payload.createIfMissing) {
          return { status: "pending", fetchStatus };
        }
        return success(undefined as D, fetchStatus);
      },

      networkQueryError: (
        state: QueryResult<D>,
        payload: { error: Error; fetchStatus?: FetchStatus },
      ) =>
        error(
          state,
          payload.fetchStatus ?? terminalFetchStatus(state),
          payload.error,
        ),
    },
  });
}
