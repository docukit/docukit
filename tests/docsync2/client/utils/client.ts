import { QueryClient } from "@tanstack/query-core";
import { DocSync2Client, type DocBinding } from "@docukit/docsync2/client";
import { createTestDocBinding } from "./docBinding.js";
import { createTestDocArgs, generateTestUserId } from "./generators.js";
import { createTestProvider } from "./provider.js";

export const createTestDocSyncClient = <
  D extends object,
  S extends object,
  O extends object,
>(
  docBinding: DocBinding<D, S, O>,
) => {
  const queryClient = new QueryClient();
  const docSync = new DocSync2Client({
    queryClient,
    docBinding,
    server: { url: "ws://localhost", auth: { getToken: () => "token" } },
    local: {
      provider: () => createTestProvider(docBinding),
      getIdentity: () => ({
        userId: generateTestUserId(),
        secret: "test-secret",
      }),
    },
  });

  return { queryClient, docSync };
};

export const createTestClient = () => {
  const { binding, create } = createTestDocBinding();
  const { queryClient, docSync } = createTestDocSyncClient(binding);
  const docArgs = createTestDocArgs();

  return { queryClient, docSync, create, docArgs };
};
