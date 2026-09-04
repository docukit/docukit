import type { FetchStatus, QueryResult } from "../types.js";
import { createReducer } from "./reducer.js";

/**
 * `fetchStatus` answers one question: can this query hand you the authoritative
 * document right now?
 *
 * - `fetching` — not yet. The document is being loaded for the first time, or
 *   re-synchronised after the connection came back.
 * - `idle` — yes, and it is up to date.
 * - `paused` — no, and it will not be until the connection returns.
 *
 * A routine background sync does **not** change that answer. DocSync is
 * realtime over a persistent socket and applies local edits optimistically, so
 * while a push is in flight the document the user is reading is already
 * correct. Remote operations arriving from the server are applied to the live
 * document instance, which is why they do not produce a new query result
 * either — only a wholesale document replacement does, and that is rare.
 *
 * ## Why not report every push as `fetching`
 *
 * The alternative — flipping `idle → fetching → idle` around every sync, the
 * way TanStack Query reports a background refetch — was considered and
 * rejected. It has two costs and no benefit this API needs:
 *
 * 1. It overloads `fetchStatus` with two unrelated meanings: "I cannot give
 *    you the document" and "there is a push in flight". Applications care
 *    about the first and can do nothing with the second.
 * 2. Every sync would emit two new query results. With the 50ms collaborative
 *    debounce that is roughly 40 re-renders per second of the whole subtree
 *    under `useDoc`, for a document that never changed identity. Measured, not
 *    estimated: 5 background syncs produced 10 distinct result objects and
 *    exactly 1 distinct document.
 *
 * **If you want a "Saving…" indicator** like Google Docs, build it from the
 * client's `sync` event rather than from `fetchStatus`: it fires once per sync
 * with the request and its outcome, which is precisely the signal such an
 * indicator needs, and it costs nothing to applications that do not want one.
 */
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
 * A sync that confirms what the query already holds has nothing to report.
 * Returning the current state keeps its identity, so React and other external
 * stores treat it as no change at all — this is what keeps a settled document
 * from re-rendering on every background push.
 */
function successOrUnchanged<D>(
  state: QueryResult<D>,
  data: D,
  fetchStatus: FetchStatus,
): QueryResult<D> {
  if (
    state.status === "success" &&
    state.data === data &&
    state.fetchStatus === fetchStatus
  ) {
    return state;
  }
  return success(data, fetchStatus);
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
          : successOrUnchanged(state, payload.data, state.fetchStatus),

      localQueryError: (state: QueryResult<D>, payload: { error: Error }) =>
        error(state, terminalFetchStatus(state), payload.error),

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
        successOrUnchanged(state, payload.data, terminalFetchStatus(state)),

      networkDocNotFound: (
        state: QueryResult<D>,
        payload: { createIfMissing: boolean },
      ): QueryResult<D> => {
        const fetchStatus = terminalFetchStatus(state);
        if (state.status === "success") {
          return successOrUnchanged(state, state.data, fetchStatus);
        }
        if (state.status === "error" && state.data !== undefined) {
          return success(state.data, fetchStatus);
        }
        if (payload.createIfMissing) {
          return { status: "pending", fetchStatus };
        }
        return success(undefined as D, fetchStatus);
      },

      networkQueryError: (state: QueryResult<D>, payload: { error: Error }) =>
        error(state, terminalFetchStatus(state), payload.error),
    },
  });
}
