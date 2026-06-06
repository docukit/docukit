# @docukit/docsync2

Minimal experimental rewrite of DocSync around TanStack Query Core.

This package is intentionally small for now. Some exported APIs are scaffolds
and may throw `not implemented yet` until the runtime is filled in.

## Basic Shape

```ts
import { QueryClient } from "@tanstack/query-core";
import { DocSync2Client, createDoc, docQuery } from "@docukit/docsync2/client";

const queryClient = new QueryClient();
const docSync = new DocSync2Client({ queryClient });

await createDoc(queryClient, { type: "note", id: "note-1" });

const query = docQuery({ type: "note", id: "note-1" });
```

## Differences From `@docukit/docsync`

- Built around TanStack Query Core from the start.
- Query status, fetch status, observers, and mutation state belong to TanStack.
- Document creation is explicit through `createDoc`; `docQuery` only reads.
- `docQuery` always requires a stable `id`.
- There is no `createIfMissing` query option.
- There are no React hooks in this package.
- There are no callback APIs like `getDoc` or `getPresence`.
- There is no old `QueryResult`, `FetchStatus`, or reducer query state.
- Socket protocol and provider contracts are intentionally not copied in full yet.
- The package is self-contained and does not import implementation from `@docukit/docsync`.

## Current Status

- Public API names and query keys are scaffolded.
- `DocBinding`, `createDocBinding`, and the DocNode binding are available.
- `DocSync2Client`, `DocSync2Server`, mutations, and providers are not fully implemented yet.
- The next work should make one small runtime path real before expanding sync behavior.
