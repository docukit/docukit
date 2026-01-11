import { InMemoryServerProvider } from "@docnode/docsync/testing";
import type { Provider } from "../../../../packages/docsync/dist/src/client/types.js";
// import { PostgresProvider } from "../../../../packages/docsync/dist/src/server/providers/postgres/index.js";
import { IndexedDBProvider } from "../../../../packages/docsync/dist/src/client/providers/indexeddb.js";
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
