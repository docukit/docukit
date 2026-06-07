# @docukit/docsync2

Minimal experimental rewrite of DocSync around TanStack Query Core.

This package is intentionally small for now. Some exported APIs are scaffolds
and may throw `not implemented yet` until the runtime is filled in.

## Basic Shape

```ts
import { QueryClient } from "@tanstack/query-core";
import { DocSync2Client } from "@docukit/docsync2/client";

const queryClient = new QueryClient();
const docSync = new DocSync2Client({ queryClient, docBinding });

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
- Socket protocol and provider contracts are intentionally not copied in full yet.
- The package is self-contained and does not import implementation from `@docukit/docsync`.

## Current Status

- Public API names and query keys are scaffolded.
- `DocBinding`, `createDocBinding`, and the DocNode binding are available.
- `DocSync2Client` configures TanStack Query defaults for `["docsync2"]` with `staleTime: Infinity`.
- `docSync.mutations.createDoc` creates a local doc through `docBinding` and seeds TanStack Query.
- `docSync.queries.getDoc` lets TanStack Query own the cached result and returns `doc: undefined` when the doc has not been created.
- `DocSync2Client`, `DocSync2Server`, presence, sync, persistence, and providers are not fully implemented yet.
- The next work should make local persistence real before expanding socket sync behavior.
