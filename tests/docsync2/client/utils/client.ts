import { QueryClient } from "@tanstack/query-core";
import {
  DocSyncClient,
  indexedDBProvider,
  type ClientConfig,
  type ClientProvider,
  type DocBinding,
} from "@docukit/docsync2/client";
import { DocNodeBinding } from "@docukit/docsync2/docnode";
import {
  defineNode,
  type Doc,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import { inject } from "vitest";
import { createTestDocArgs, generateTestUserId } from "./generators.js";

export const TestNode = defineNode({ type: "test" });

declare global {
  var __DOCSYNC2_TEST_SERVER_PORT__: number | undefined;
  var __TEST_SERVER_PORT__: number | undefined;
}

const getTestServerUrl = () => {
  const port: number | undefined =
    inject("docsync2TestServerPort") ??
    globalThis.__DOCSYNC2_TEST_SERVER_PORT__;
  if (port === undefined) throw new Error("Missing DocSync2 test server port");

  return `ws://localhost:${port}`;
};

export const createTestDocSyncClient = <
  D extends object,
  S extends object,
  O extends object,
>(
  docBinding: DocBinding<D, S, O>,
  options?: { timing?: ClientConfig<D, S, O>["timing"]; userId?: string },
) => {
  const userId = options?.userId ?? generateTestUserId();
  const identity = { userId, secret: "test-secret" };
  const provider: ClientProvider<S, O> = indexedDBProvider(identity);
  const docSync = new DocSyncClient({
    docBinding,
    server: {
      url: getTestServerUrl(),
      auth: { getToken: () => `test-token-${userId}` },
    },
    local: { provider: () => provider, getIdentity: () => identity },
    ...(options?.timing ? { timing: options.timing } : {}),
  });
  const queryClient = docSync["_queryClient"];

  return { queryClient, docSync, provider };
};

export type TestClient = {
  queryClient: QueryClient;
  docSync: DocSyncClient<Doc, JsonDoc, Operations>;
  docBinding: DocBinding<Doc, JsonDoc, Operations>;
  docArgs: ReturnType<typeof createTestDocArgs>;
  provider: ClientProvider<JsonDoc, Operations>;
};

export const createTestClient = (options?: {
  timing?: ClientConfig<Doc, JsonDoc, Operations>["timing"];
  userId?: string;
}): TestClient => {
  const docArgs = createTestDocArgs();
  const binding = DocNodeBinding([
    { type: docArgs.type, extensions: [{ nodes: [TestNode] }] },
  ]);
  const { queryClient, docSync, provider } = createTestDocSyncClient(
    binding,
    options,
  );

  return { queryClient, docSync, docBinding: binding, docArgs, provider };
};
