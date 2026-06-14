# @docukit/docsync2

## Example

```ts
import { QueryClient } from "@tanstack/query-core";
import { DocSyncClient, indexedDBProvider } from "@docukit/docsync2/client";
import { DocNodeBinding, DocNodeValidators } from "@docukit/docsync2/docnode";
import { DocSyncServer } from "@docukit/docsync2/server";

const queryClient = new QueryClient(); // dedicated to DocSync
const docSync = new DocSyncClient({
  queryClient,
  docBinding: DocNodeBinding([{ type: "note", extensions: [] }]),
  server: { url: "ws://localhost:3000", auth: { getToken } },
  local: { provider: indexedDBProvider, getIdentity },
});

const query = docSync.queries.getDoc({ type: "note", id: "note-1" });
await docSync.mutations.createDoc({ type: "note", id: "note-1" });
const server = new DocSyncServer({
  validators: DocNodeValidators(),
  provider,
  authenticate,
});
```

## Differences From `@docukit/docsync`

- Uses TanStack Query for status, observers, cache, and mutations.
- The `QueryClient` is owned by DocSync and follows socket online state.
- Uses `docSync.queries.getDoc` and `docSync.mutations.createDoc`.
- `createDoc` returns `{ docId }`; read the live doc through `getDoc`.
- No React hooks, callback APIs, `QueryResult`, `FetchStatus`, or reducer state.
- Original DocSync squashes operations on the server.
- This rewrite aims to squash on the client, keeping the server CRDT-agnostic.
- The server validates and persists opaque serialized docs/operations.

## Freshness Model

- IndexedDB stores DocSync domain data: serialized docs and queued operations.
- TanStack Query owns the in-memory reactive cache.
- `getDoc` owns the TanStack Query fetch lifecycle for remote freshness.
- Active docs invalidate `getDoc`; they do not run a separate sync mutation.
- IndexedDB seeds stale local data (`dataUpdatedAt: 0`), so remote sync can be
  `fetching` or `paused` while local data is visible.
- Sync can send a client snapshot; the server stores it only up to the request
  clock and keeps newer operations the client has not seen.

## TODO

- Add the original DocSync debounce model for collaborative and single-client sync.

Types: `D` is the live client doc, `S` is the serialized doc, and `O` is the
operation/update. `object` includes arrays, class instances, and `Uint8Array`.
