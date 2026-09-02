import type { DocSyncClient } from "../../index.js";
import { DocSyncError } from "../../utils/DocSyncError.js";
import {
  dispatchDocQueryConnectionError,
  dispatchDocQueryDisconnected,
} from "../../utils/dispatchDocQueryAction.js";
import { clearAllSyncRetries } from "../../utils/syncRetry.js";

/**
 * Moves every loaded query to `paused`, and to `error + paused` when the
 * connection failed permanently. Socket.IO keeps `active === true` while it is
 * still retrying, so that flag is what separates a temporary interruption from
 * a rejection the client will never recover from on its own.
 */
function pauseQueries<D extends object, S extends object, O extends object>(
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

/** Tells the other tabs this client is gone from every document it had open. */
function broadcastPresenceLeft<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>): void {
  for (const docId of client["_docsCache"].keys()) {
    client["_bcHelper"]?.broadcast({
      type: "PRESENCE",
      docId,
      presence: { [client["_clientId"]]: null },
    });
  }
}

export function handleDisconnect<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("disconnect", (reason) => {
    // TODO: clearing every push lock lets a sync that is still awaiting its ack
    // run concurrently with the one `handleConnect` starts on reconnect. The
    // superseded sync settles last, so its result — success or failure — would
    // overwrite a newer one. `isSettled` in queryResultReducer.ts only stops it
    // from doing damage; the race itself is still there. The real fix is a
    // generation counter per document: `handleSync` captures it before awaiting
    // and discards its own result if the document advanced meanwhile. Simply
    // not clearing the map is not an option — an in-flight sync that never
    // resolves would leave the document stuck on "pushing" until a reload.
    client["_pushStatusByDocId"].clear();
    client["_collabDocIds"].clear();
    clearAllSyncRetries(client);
    for (const state of client["_presenceDebounceState"].values()) {
      clearTimeout(state.timeout);
      delete state.timeout;
    }
    // A manual disconnect is not a failure, so it pauses without an error.
    const connectionError =
      !client["_socket"].active && reason !== "io client disconnect"
        ? new DocSyncError(
            "ConnectionError",
            `The server disconnected the DocSync client (${reason})`,
          )
        : undefined;
    pauseQueries(client, connectionError);
    broadcastPresenceLeft(client);
    client["_events"].emit("disconnect", { reason });
  });
  client["_socket"].on("connect_error", (err) => {
    const connectionError = client["_socket"].active
      ? undefined
      : new DocSyncError("ConnectionError", err.message, { cause: err });
    pauseQueries(client, connectionError);
    client["_events"].emit("disconnect", { reason: err.message });
  });
}
