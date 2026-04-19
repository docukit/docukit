import { test } from "vitest";
import { DocSyncServer, inMemoryServerProvider } from "@docukit/docsync/server";
import type { ServerProvider } from "@docukit/docsync/server";
import { DocNodeBinding } from "@docukit/docsync/docnode";

test("ServerConfig.provider checks S/O against docBinding", () => {
  const wrongProvider = null as unknown as ServerProvider<
    { wrongS: 1 },
    { wrongO: 1 }
  >;

  const _rejected = () =>
    new DocSyncServer({
      docBinding: DocNodeBinding([]),
      // @ts-expect-error mismatched provider S/O should error
      provider: wrongProvider,
      authenticate: () => ({ userId: "x" }),
    });

  const _accepted = () =>
    new DocSyncServer({
      docBinding: DocNodeBinding([]),
      provider: inMemoryServerProvider(),
      authenticate: () => ({ userId: "x" }),
    });
});
