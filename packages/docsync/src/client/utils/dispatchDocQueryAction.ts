import type { DocSyncClient } from "../index.js";
import type { DocData } from "../types.js";
import { createQueryResultReducer } from "./queryResultReducer.js";

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

export function dispatchDocQueryConnected<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.connected(undefined);
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchDocQueryFetchStarted<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.fetchStarted(undefined);
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchDocQueryConnectionError<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, error: Error): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.connectionError({ error });
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchDocQueryDisconnected<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.disconnected(undefined);
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}

export function dispatchNetworkDocFound<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, data: DocData<D>): void {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

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

  const reducer = createQueryResultReducer({
    initialState: cacheEntry.queryResult,
  });
  const next = reducer.action.networkQueryError({ error });
  if (next !== cacheEntry.queryResult) client["_emitQueryResult"](docId, next);
}
