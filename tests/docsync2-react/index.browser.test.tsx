import { expect, inject, test } from "vitest";
import {
  createDocSyncClient,
  indexedDBProvider,
  isExistingGetDocData,
} from "@docukit/docsync2-react/client";
import { DocNodeBinding } from "@docukit/docsync2-react/docnode";
import { renderHook } from "vitest-browser-react";
import { docConfig, id } from "../docsync-react/utils.js";

declare global {
  var __DOCSYNC2_TEST_SERVER_PORT__: number | undefined;
}

const testServerUrl = () => {
  const injectedPort: number | undefined = inject("docsync2TestServerPort");
  const port = injectedPort ?? globalThis.__DOCSYNC2_TEST_SERVER_PORT__ ?? 8083;
  return `ws://localhost:${port}`;
};

test("useDoc reads a DocSync2 getDoc query through React Query", async () => {
  const { client, useDoc } = createDocSyncClient({
    server: {
      url: testServerUrl(),
      auth: { mode: "token", getToken: () => "test-token-docsync2-react" },
    },
    local: { provider: indexedDBProvider },
    docBinding: DocNodeBinding([docConfig]),
  });

  try {
    const docArgs = { type: "test", id: id.ending("6"), createIfMissing: true };

    const { result } = await renderHook(() => useDoc(docArgs));

    await expect
      .poll(() => result.current.status, { interval: 50, timeout: 2000 })
      .toBe("success");
    const data: unknown = result.current.data;
    expect(isExistingGetDocData(data)).toBe(true);
    if (!isExistingGetDocData(data)) return;
    expect(data.docId).toBe(docArgs.id);
    expect(data.doc).toBeDefined();
  } finally {
    client.disconnect();
    client.dispose();
  }
});
