# @docukit/docsync2

Small experimental DocSync rewrite around TanStack Query Core. Some APIs are
scaffolds and may still throw `not implemented yet`.

## Example

```ts
import { QueryClient } from "@tanstack/query-core";
import { DocSyncClient, indexedDBProvider } from "@docukit/docsync2/client";
import { DocNodeBinding, DocNodeValidators } from "@docukit/docsync2/docnode";
import { DocSyncServer } from "@docukit/docsync2/server";

const queryClient = new QueryClient();
const docBinding = DocNodeBinding([{ type: "note", extensions: [] }]);

const docSync = new DocSyncClient({
  queryClient,
  docBinding,
  server: { url: "ws://localhost:3000", auth: { getToken } },
  local: { provider: indexedDBProvider, getIdentity },
});

await docSync.mutations.createDoc({ type: "note", id: "note-1" });
const query = docSync.queries.getDoc({ type: "note", id: "note-1" });

const server = new DocSyncServer({
  validators: DocNodeValidators(),
  provider,
  authenticate,
});
```

## Differences From `@docukit/docsync`

- Uses TanStack Query for query status, observers, cache, and mutations.
- Uses `docSync.queries.getDoc` and `docSync.mutations.createDoc`.
- No React hooks, callback APIs, `QueryResult`, `FetchStatus`, or reducer state.
- Original DocSync squashes operations on the server after enough operations.
- This rewrite aims to squash on the client, keeping the server CRDT-agnostic.
- The server validates, persists, and forwards opaque serialized docs/operations.

## Types

- `D`: live document, client-only, handled by `DocBinding`.
- `S`: serialized document, validated and stored by the server.
- `O`: operation/update, validated and stored by the server.
- `DocNodeBinding` and `DocNodeValidators()` are exported from `/docnode`.

`object` means non-primitive: arrays, class instances, and `Uint8Array` fit.
