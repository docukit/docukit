/**
 * Vitest globalSetup for integration tests.
 * Starts a DocSyncServer with InMemoryServerProvider before browser tests run.
 *
 * Uses @docukit/docsync/server (InMemoryServerProvider) to avoid loading PostgresProvider which requires DB env vars.
 */
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { testDocConfig } from "./utils.js";
import { DocSyncServer, InMemoryServerProvider } from "@docukit/docsync/server";
import { createServer } from "node:net";

const PREFERRED_PORT = 8082;

// Extend globalThis to include test server port
declare global {
  var __TEST_SERVER_PORT__: number | undefined;
}

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

export async function setup() {
  // Find an available port
  serverPort = await findAvailablePort(PREFERRED_PORT);

  server = new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port: serverPort,
    provider: InMemoryServerProvider,
    authenticate: async ({ token }) => {
      const userId = parseTestToken(token);
      if (!userId) return undefined;
      return { userId };
    },
  });

  // Give the server a moment to start
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`✅ Test server ready on port ${serverPort}\n`);

  // Store the port in globalThis so tests can access it
  globalThis.__TEST_SERVER_PORT__ = serverPort;
}

export async function teardown() {
  if (server) await server.close();
  console.log("✅ Test server stopped\n");
}
