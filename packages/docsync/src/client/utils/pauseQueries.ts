import type { DocSyncClient } from "../index.js";
import type { DocSyncError } from "./DocSyncError.js";
import {
  dispatchAllDocQueriesConnectionError,
  dispatchAllDocQueriesDisconnected,
} from "./dispatchDocQueryAction.js";

/**
 * Moves every loaded query to `paused`, and to `error + paused` when the
 * connection failed permanently. Socket.IO keeps `active === true` while it is
 * still retrying, so that flag is what separates a temporary interruption from
 * a rejection the client will never recover from on its own.
 */
export function pauseQueries<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  connectionError: DocSyncError | undefined,
): void {
  client["_connectionFetchStatus"] = "paused";
  if (connectionError) client["_connectionError"] = connectionError;
  if (connectionError) {
    dispatchAllDocQueriesConnectionError(client, connectionError);
  } else {
    dispatchAllDocQueriesDisconnected(client);
  }
}
