import type { DocSyncClient } from "../index.js";
import type { DocSyncError } from "./DocSyncError.js";
import {
  dispatchDocQueryConnectionError,
  dispatchDocQueryDisconnected,
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
  for (const docId of client["_docsCache"].keys()) {
    if (connectionError) {
      dispatchDocQueryConnectionError(client, docId, connectionError);
    } else {
      dispatchDocQueryDisconnected(client, docId);
    }
  }
}
