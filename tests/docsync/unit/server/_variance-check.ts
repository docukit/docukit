// Compile-time only: verifies that ServerProvider<S, O>'s S/O are checked
// against the docBinding in ServerConfig. Runtime is intentionally unreachable.

import { DocSyncServer, inMemoryServerProvider } from "@docukit/docsync/server";
import type { ServerProvider } from "@docukit/docsync/server";
import { DocNodeBinding } from "@docukit/docsync/docnode";

declare const _NEVER: false;

if (_NEVER) {
  // 1. inMemoryServerProvider() infers S/O from docBinding — accepted
  new DocSyncServer({
    docBinding: DocNodeBinding([]),
    provider: inMemoryServerProvider(),
    authenticate: () => ({ userId: "x" }),
  });

  // 2. Provider explicitly typed for different S/O — rejected
  const wrongProvider = null as unknown as ServerProvider<
    { wrongS: 1 },
    { wrongO: 1 }
  >;

  new DocSyncServer({
    docBinding: DocNodeBinding([]),
    // @ts-expect-error mismatched provider S/O should error
    provider: wrongProvider,
    authenticate: () => ({ userId: "x" }),
  });
}
