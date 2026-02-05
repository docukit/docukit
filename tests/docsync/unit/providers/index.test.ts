import type { Provider } from "@docukit/docsync";
import { IndexedDBProvider } from "@docukit/docsync/client";
import { InMemoryServerProvider } from "@docukit/docsync/testing";
import { test } from "vitest";

function testProvider<T extends "server" | "client", S, O>(
  _type: T,
  _provider: Provider<S, O, T>,
) {
  throw new Error("Not implemented");
}

test.todo("in memory provider", () => {
  testProvider("server", new InMemoryServerProvider());
});

// test.todo("postgres provider", () => {
//   testProvider("server", new PostgresProvider());
// });

test.todo("indexeddb provider", () => {
  testProvider(
    "client",
    new IndexedDBProvider({ userId: "test-user", secret: "test-secret" }),
  );
});
