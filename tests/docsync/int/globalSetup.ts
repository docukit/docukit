/**
 * Vitest globalSetup for integration tests.
 * Starts DocNode and Yjs DocSyncServers with InMemoryServerProvider before browser tests run.
 */
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { YjsBinding } from "@docukit/docsync/yjs";
import { testDocConfig } from "./adapters.js";
import { DocSyncServer, InMemoryServerProvider } from "@docukit/docsync/server";

const DOCNODE_PORT = 8082;
const YJS_PORT = 8083;

/**
 * Test token format: "test-token-{userId}"
 * This allows tests to authenticate as different users.
 */
const parseTestToken = (token: string): string | undefined => {
  const prefix = "test-token-";
  if (!token.startsWith(prefix)) return undefined;
  return token.slice(prefix.length);
};

const authenticate = ({ token }: { token: string }) => {
  const userId = parseTestToken(token);
  if (!userId) return undefined;
  return { userId };
};

let docNodeServer: DocSyncServer | undefined;
let yjsServer: DocSyncServer | undefined;

export async function setup() {
  docNodeServer = new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port: DOCNODE_PORT,
    provider: InMemoryServerProvider,
    authenticate,
  });

  yjsServer = new DocSyncServer({
    docBinding: YjsBinding(),
    port: YJS_PORT,
    provider: InMemoryServerProvider,
    authenticate,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(
    `\n  Test servers ready: DocNode(:${DOCNODE_PORT}) Yjs(:${YJS_PORT})\n`,
  );
}

export async function teardown() {
  if (docNodeServer) await docNodeServer.close();
  if (yjsServer) await yjsServer.close();
  console.log("\n  Test servers stopped\n");
}
