/**
 * Vitest globalSetup for integration tests.
 * Starts a DocSyncServer with inMemoryServerProvider before browser tests run.
 *
 * Uses @docukit/docsync/server (inMemoryServerProvider) to avoid loading PostgresProvider which requires DB env vars.
 */
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { testDocConfig } from "./utils.js";
import { DocSyncServer, inMemoryServerProvider } from "@docukit/docsync/server";
import type { TestProject } from "vitest/node";
import { createServer } from "node:net";

const PREFERRED_PORT = 8082;

declare module "vitest" {
  export interface ProvidedContext {
    testServerPort: number;
  }
}

// Extend globalThis to include test server port
declare global {
  var __TEST_SERVER_PORT__: number | undefined;
  /** Used by the DocSync server commands in vitest.config.ts. */
  var __DOCSYNC_FORGET_SERVER_DOC__: ((docId: string) => void) | undefined;
  var __DOCSYNC_OWN_SERVERS__:
    | {
        start: () => Promise<number>;
        restart: (port: number) => Promise<void>;
        stop: (port: number) => Promise<void>;
      }
    | undefined;
}

/**
 * In-memory provider that can lose one document, like a server whose copy
 * expired or was wiped while clients kept theirs.
 */
const createForgetfulProvider = () => {
  const base = inMemoryServerProvider();
  const replacements = new Map<string, typeof base>();
  const provider: typeof base = {
    transaction: (options, callback) =>
      (replacements.get(options.docId) ?? base).transaction(options, callback),
  };
  const forgetDoc = (docId: string) => {
    replacements.set(docId, inMemoryServerProvider());
  };
  return { provider, forgetDoc };
};

/**
 * Find an available port starting from the preferred port.
 */
async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Port is in use, try next one
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
    server.listen(startPort, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Test token format: "test-token-{userId}"
 * This allows tests to authenticate as different users.
 */
const parseTestToken = (token: string): string | undefined => {
  const prefix = "test-token-";
  if (!token.startsWith(prefix)) return undefined;
  return token.slice(prefix.length);
};

let server: DocSyncServer | undefined;
let serverPort: number;

const createTestServer = (
  port: number,
  provider: ReturnType<typeof inMemoryServerProvider>,
) =>
  new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port,
    provider,
    authenticate: ({ token }) => {
      if (!token) return undefined;
      const userId = parseTestToken(token);
      if (!userId) return undefined;
      return { userId };
    },
  });

/**
 * Servers started by a test for itself. A restart keeps the provider, like a
 * server process that restarts on top of the same database.
 */
const ownServers = new Map<
  number,
  { server: DocSyncServer; provider: ReturnType<typeof inMemoryServerProvider> }
>();

globalThis.__DOCSYNC_OWN_SERVERS__ = {
  start: async () => {
    const port = await findAvailablePort(PREFERRED_PORT + 100);
    const provider = inMemoryServerProvider();
    ownServers.set(port, {
      server: createTestServer(port, provider),
      provider,
    });
    return port;
  },
  restart: async (port) => {
    const own = ownServers.get(port);
    if (!own) throw new Error(`No test server on port ${port}`);
    await own.server.close();
    own.server = createTestServer(port, own.provider);
  },
  stop: async (port) => {
    await ownServers.get(port)?.server.close();
    ownServers.delete(port);
  },
};

export async function setup(project: TestProject) {
  // Find an available port
  serverPort = await findAvailablePort(PREFERRED_PORT);

  const { provider, forgetDoc } = createForgetfulProvider();
  globalThis.__DOCSYNC_FORGET_SERVER_DOC__ = forgetDoc;
  server = createTestServer(serverPort, provider);

  // Give the server a short moment to finish binding before browser workers connect.
  await new Promise((resolve) => setTimeout(resolve, 10));
  console.log(`✅ Test server ready on port ${serverPort}\n`);

  // Store the port in globalThis so tests can access it
  globalThis.__TEST_SERVER_PORT__ = serverPort;
  project.provide("testServerPort", serverPort);
}

export async function teardown() {
  globalThis.__DOCSYNC_FORGET_SERVER_DOC__ = undefined;
  for (const port of ownServers.keys()) {
    await globalThis.__DOCSYNC_OWN_SERVERS__?.stop(port);
  }
  if (server) await server.close();
  console.log("✅ Test server stopped\n");
}
