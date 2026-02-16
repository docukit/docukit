import type { ClientProvider } from "@docukit/docsync/client";
import type { ServerProvider } from "@docukit/docsync/server";
import { IndexedDBProvider } from "@docukit/docsync/client";
import { InMemoryServerProvider } from "@docukit/docsync/testing";
import { test } from "vitest";

function testProviderServer<S, O>(_provider: ServerProvider<S, O>) {
  throw new Error("Not implemented");
}

function testProviderClient<S, O>(_provider: ClientProvider<S, O>) {
  throw new Error("Not implemented");
}

test.todo("in memory provider", () => {
  testProviderServer(new InMemoryServerProvider());
});

// test.todo("postgres provider", () => {
//   testProvider("server", new PostgresProvider());
// });

test.todo("indexeddb provider", () => {
  testProviderClient(
    new IndexedDBProvider({ userId: "test-user", secret: "test-secret" }),
  );
});
