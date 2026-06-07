# @docukit/docsync2

Minimal experimental rewrite of DocSync around TanStack Query Core.

This package is intentionally small for now. Some exported APIs are scaffolds
and may throw `not implemented yet` until the runtime is filled in.

## Basic Shape

```ts
import { QueryClient } from "@tanstack/query-core";
import { DocSyncClient, indexedDBProvider } from "@docukit/docsync2/client";

const queryClient = new QueryClient();
const docSync = new DocSyncClient({
  queryClient,
  docBinding,
  server: {
    url: "ws://localhost:3000",
    auth: { getToken: () => "server-token" },
  },
  local: {
    provider: (identity) => indexedDBProvider(identity),
    getIdentity: () => ({ userId: "user-1", secret: "local-secret" }),
  },
});

await docSync.mutations.createDoc({ type: "note", id: "note-1" });

const query = docSync.queries.getDoc({ type: "note", id: "note-1" });
```

## Differences From `@docukit/docsync`

- Built around TanStack Query Core from the start.
- Query status, fetch status, observers, and mutation state belong to TanStack.
- Document creation is explicit through `docSync.mutations.createDoc`; `docSync.queries.getDoc` only reads.
- `getDoc` always requires a stable `id`.
- There is no `createIfMissing` query option.
- There are no React hooks in this package.
- There are no callback APIs like the original `getDoc` or `getPresence`.
- There is no old `QueryResult`, `FetchStatus`, or reducer query state.
- Server code is currently copied from `@docukit/docsync` and still needs adaptation.
- Client provider contracts exist, but their implementation is still minimal.
- The package is self-contained and does not import implementation from `@docukit/docsync`.

## Type Constraints

`DocBinding` uses `object` for the live document, serialized document, and
operation/update types. In TypeScript, `object` means "not a primitive"; it is
not limited to plain records. This accepts class instances like `Y.Doc` or
`LoroDoc`, arrays/tuples like DocNode data, and binary values like `Uint8Array`.

## Current Status

- Public API names and query keys are scaffolded.
- `DocBinding`, `createDocBinding`, and the DocNode binding are available.
- `DocSyncClient` configures TanStack Query defaults for `["docsync"]` with `staleTime: Infinity`.
- `docSync.mutations.createDoc` creates a local doc through `docBinding` and seeds TanStack Query.
- `docSync.queries.getDoc` lets TanStack Query own the cached result and returns `doc: undefined` when the doc has not been created.
- `DocSyncClient`, `DocSyncServer`, presence, sync, persistence, and providers are not fully implemented yet.
- The next work should make local persistence real before expanding socket sync behavior.
