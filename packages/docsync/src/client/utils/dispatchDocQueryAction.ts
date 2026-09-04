import type { DocSyncClient } from "../index.js";
import type { DocData } from "../types.js";
import { createQueryResultReducer } from "./queryResultReducer.js";

/**
 * Terminal network actions are dispatched by the sync attempt that just
 * released the document, so `activeSyncAttempt` must still be clear. If a newer
 * attempt has already claimed it, this dispatch belongs to a superseded one and
 * would overwrite the newer result.
 *
 * `fetchStatus` used to carry this guarantee: while every sync flipped the
 * query to `fetching`, an `idle` query meant "no attempt in flight". A routine
 * background push no longer touches `fetchStatus` (see `queryResultReducer`),
 * so the invariant is anchored to the attempt token itself, which is the only
 * thing that actually knows.
 *
 * This throws rather than returning quietly. The window it protects is
 * synchronous today, so reaching it means an `await` was added between
 * `finishSyncAttempt` and the dispatch — an ordering bug that would otherwise
 * surface as an update that silently disappears, which no test can catch.
 */
function assertNoNewerSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, actionType: string): void {
  if (client["_docsCache"].get(docId)?.activeSyncAttempt === undefined) return;
  throw new Error(
    `Cannot apply ${actionType}: a newer sync attempt for "${docId}" is already running`,
  );
}

export function dispatchLocalDocFound<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, data: DocData<D>): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.localDocFound({ data });
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchLocalQueryError<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, error: Error): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.localQueryError({ error });
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchAllDocQueriesConnected<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>): void {
  const updates = [...client["_docsCache"]].map(([docId, cacheEntry]) => ({
    docId,
    result: createQueryResultReducer({
      initialState: cacheEntry.queryResult,
    }).action.connected(undefined),
  }));
  client["_emitQueryResults"](updates);
}

export function dispatchAllDocQueriesConnectionError<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, error: Error): void {
  const updates = [...client["_docsCache"]].map(([docId, cacheEntry]) => ({
    docId,
    result: createQueryResultReducer({
      initialState: cacheEntry.queryResult,
    }).action.connectionError({ error }),
  }));
  client["_emitQueryResults"](updates);
}

export function dispatchAllDocQueriesDisconnected<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>): void {
  const updates = [...client["_docsCache"]].map(([docId, cacheEntry]) => ({
    docId,
    result: createQueryResultReducer({
      initialState: cacheEntry.queryResult,
    }).action.disconnected(undefined),
  }));
  client["_emitQueryResults"](updates);
}

export function dispatchNetworkDocFound<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, data: DocData<D>): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  assertNoNewerSyncAttempt(client, docId, "networkDocFound");

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.networkDocFound({ data });
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchNetworkDocNotFound<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  payload: { createIfMissing: boolean },
): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  assertNoNewerSyncAttempt(client, docId, "networkDocNotFound");

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.networkDocNotFound(payload);
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchNetworkQueryError<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, error: Error): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  assertNoNewerSyncAttempt(client, docId, "networkQueryError");

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.networkQueryError({ error });
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}
