Visit [our website](https://docukit.dev) for documentation and more.

## A shared engine for pages and workers

Pages import `DocSyncClient` from `@docukit/docsync/client` as before. It extends
`DocSyncCore`, adding stable document observers for external-store consumers
and the public presence methods. Workers can import `DocSyncCore` directly
from `@docukit/docsync/core` and subscribe to document state without that adapter.
Both constructors accept the same configuration and use the same socket,
IndexedDB identity, reconciliation, retries and live document cache.

```ts
import { DocSyncCore } from "@docukit/docsync/core";

// Use the same server, local provider and document binding configuration.
const core = new DocSyncCore(config);
const release = core.subscribeDoc({ type: "notes", id: docId }, (result) => {
  // Called immediately with the current state, then on loading/sync changes.
  // Observe result.data.doc.onChange separately for document content edits.
});
// When the document is no longer needed:
release();
```

The constructor stays synchronous. The engine waits for IndexedDB before
socket authentication and local document access. A core subscription starts
local loading and network synchronization, stays subscribed across reconnects,
and receives errors through the same query states as the UI client.

The core retains the presence protocol and CRDT instances used by synchronization.
This separation removes the external-store adapter from the worker entry; it
does not introduce a separate transport or a second reconciliation algorithm.

`deviceId` and the cached `userId` live in a small `docsync:metadata` database.
Concurrent starts choose one device ID in one transaction. Document databases
remain separate for each user. The cached user ID is a namespace hint; the
server still authenticates every connection.

Existing localStorage IDs are migrated once when a page starts the client.
On the first run after upgrading an existing installation, initialize that
page client before starting its worker. A worker cannot read the old
localStorage values. Later starts use IndexedDB in both environments.

`await client.clearLocalIdentity()` clears the cached user ID, keeps the device
ID and prevents legacy storage from restoring the user ID. Await it before
navigating away on logout.

Concurrent sync attempts for the same user and document use a Web Lock when
available. When closing an editor, first commit its binding's pending changes,
then `await client.flush(docId)` before releasing any application lock that
allows a background worker to open that document.

This does not extend the lifetime of a worker. The application still controls
which documents it observes, authentication credentials, and worker lifetime.

## Error and retry policy

DocSync reports every server response or transport-level request failure
immediately through the `sync` event. `QueryResult.error` has a narrower
meaning: it is set only when DocSync cannot make progress automatically. A
failed attempt does not change the query result while a retry or a newer queued
sync can still succeed.

| Failure or situation                                                        | Automatic policy                                                             | Query result exposed to applications                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Server returns `AuthorizationError`                                         | Do not retry because the same request will be rejected again                 | Set `status: "error"` immediately and preserve existing data                     |
| Server returns `ValidationError`                                            | Do not retry because the request must change first                           | Set `status: "error"` immediately and preserve existing data                     |
| Server returns `DatabaseError`                                              | Retry eight times with exponential backoff for about 24 seconds              | Leave the current result untouched; set `error` only after retries are exhausted |
| A sync request fails at the transport level                                 | Convert it to `NetworkError` and use the same bounded retry policy           | Leave the current result untouched; set `error` only after retries are exhausted |
| Local storage or a configured local provider throws                         | Do not retry automatically                                                   | Set `status: "error"` immediately; the original error is preserved               |
| A document binding throws during sync                                       | Do not retry automatically; rethrow so the programming failure stays visible | Set `status: "error"` immediately unless a newer sync is already queued          |
| Getting an authentication token fails                                       | Stop the connection attempt                                                  | Set `ConnectionError` immediately with `fetchStatus: "paused"`                   |
| The server permanently rejects or ends the connection                       | Stop reconnecting automatically                                              | Set `ConnectionError` immediately with `fetchStatus: "paused"`                   |
| The transport disconnects temporarily while Socket.IO is still reconnecting | Let Socket.IO reconnect; cancel document retry timers until it does          | Preserve `status`, `data`, and any existing `error`; set `fetchStatus: "paused"` |
| The application disconnects manually                                        | Do not treat an intentional action as a failure                              | Preserve the result without adding an error; set `fetchStatus: "paused"`         |

The document retry delays are approximately `300ms`, `600ms`, `1.2s`, `2.4s`,
`4.8s`, then `5s` three times. The budget covers one episode of failure: a
successful sync, a transport reconnect, and exhausting the budget all reset it,
so a later edit gets its own bounded chain. If a newer sync was queued while an
attempt was in flight, the queued sync runs before the failed attempt can
become a terminal query error.

A loaded document whose background syncs start failing therefore keeps
reporting `success` for as long as the retry chain lasts — up to about 24
seconds — before `error` appears on the query. The edits are already in local
storage, so nothing is lost, but an application that wants to react sooner
should listen to the `sync` event, which fires on every attempt including the
failed ones.

For user interfaces, treat `error` as actionable and `paused` as potentially
temporary. An application can keep rendering stale data alongside an error and
may delay a connectivity notice to avoid flashing warnings during brief
interruptions.

## What `fetchStatus` does and does not mean

`fetchStatus` answers exactly one question: can this query serve the
authoritative document right now?

- `fetching` — not yet. It is loading for the first time, resynchronising after
  a reconnect, or waiting on a scheduled retry.
- `idle` — yes, and it is up to date.
- `paused` — no, and it will not be until the connection returns.

A routine background sync does **not** change that answer, and therefore does
not change the query result at all. DocSync is realtime over a persistent
socket and applies local edits optimistically, so while a push is in flight the
document the user is reading is already correct. Remote operations arriving
from other clients are applied to the same live document instance rather than
replacing it. Only a wholesale document replacement changes `data`, and that is
rare.

### The alternative that was rejected

Flipping `idle → fetching → idle` around every sync — the way TanStack Query
reports a background refetch — was considered and deliberately not adopted. It
overloads `fetchStatus` with a second, unrelated meaning ("a push is in
flight") that applications cannot act on, and it emits two new query results
per sync. At the 50ms collaborative debounce that is roughly 40 re-renders per
second of everything rendered under `useDoc`, for a document whose identity
never changed. Measured on the current test client: 5 background syncs emit 0
query results, against 10 under the rejected design.

### Building a "Saving…" indicator

If you want a Google Docs style save indicator, build it from the `sync` event
rather than from `fetchStatus`. It fires once per sync with the request and its
outcome, which is the signal such an indicator needs, and keeping it out of the
query result costs nothing to applications that do not want one.

```ts
client.on("sync", ({ req, data, error }) => {
  // `req` is the outgoing sync request, `data` the server result,
  // `error` the failure when the sync did not succeed.
});
```
