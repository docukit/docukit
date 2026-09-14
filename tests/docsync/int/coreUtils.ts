import { inject } from "vitest";
import { DocSyncCore, indexedDBProvider } from "@docukit/docsync/core";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { seedMetadata } from "../metadataUtils.js";
import { testDocConfig } from "./utils.js";

export const createCore = async (userId: string) => {
  await seedMetadata(userId, crypto.randomUUID());
  return new DocSyncCore({
    server: {
      url: `ws://localhost:${inject("testServerPort")}`,
      auth: { mode: "token", getToken: () => `test-token-${userId}` },
    },
    local: { provider: indexedDBProvider },
    docBinding: DocNodeBinding([testDocConfig]),
  });
};
