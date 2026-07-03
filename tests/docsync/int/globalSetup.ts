/**
 * Vitest globalSetup for integration tests.
 * Starts a DocSyncServer with inMemoryServerProvider before browser tests run.
 *
 * Uses @docukit/docsync/server (inMemoryServerProvider) to avoid loading PostgresProvider which requires DB env vars.
 */
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { testDocConfig } from "./utils.js";
import { DocSyncServer, inMemoryServerProvider } from "@docukit/docsync/server";
import { DocNodeValidators } from "@docukit/docsync2/docnode";
import {
  DocSyncServer as DocSync2Server,
  inMemoryServerProvider as inMemoryDocSync2ServerProvider,
} from "@docukit/docsync2/server";
import type { JsonDoc, Operations } from "@docukit/docnode";
import type { TestProject } from "vitest/node";
import { createServer } from "node:net";

const PREFERRED_PORT = 8082;
const UNAUTHORIZED_DOC_ID = "01j00000000000000000000000";

declare module "vitest" {
  export interface ProvidedContext {
    testServerPort: number;
    docsync2TestServerPort: number;
  }
}

// Extend globalThis to include test server port
declare global {
  var __TEST_SERVER_PORT__: number | undefined;
  var __DOCSYNC2_TEST_SERVER_PORT__: number | undefined;
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

const hasDocId = (value: unknown): value is { docId: string } => {
  return (
    typeof value === "object" &&
    value !== null &&
    "docId" in value &&
    typeof value.docId === "string"
  );
};

let server: DocSyncServer | undefined;
let serverPort: number;
let docsync2Server: DocSync2Server | undefined;
let docsync2ServerPort: number;

export async function setup(project: TestProject) {
  // Find an available port
  serverPort = await findAvailablePort(PREFERRED_PORT);
  docsync2ServerPort = await findAvailablePort(serverPort + 1);

  server = new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port: serverPort,
    provider: inMemoryServerProvider(),
    authenticate: ({ token }) => {
      if (!token) return undefined;
      const userId = parseTestToken(token);
      if (!userId) return undefined;
      return { userId };
    },
  });

  const docsync2Validators = DocNodeValidators();
  docsync2Server = new DocSync2Server({
    validators: docsync2Validators,
    port: docsync2ServerPort,
    provider: inMemoryDocSync2ServerProvider<JsonDoc, Operations>(),
    authenticate: ({ request, token }) => {
      if (!token) {
        if (!request.headers.host) return undefined;
        return { userId: "docsync2-request-user" };
      }
      const userId = parseTestToken(token);
      if (!userId) return undefined;
      return { userId };
    },
    authorize: ({ req }) => {
      return !hasDocId(req) || req.docId !== UNAUTHORIZED_DOC_ID;
    },
  });

  // Give the server a moment to start
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`✅ Test server ready on port ${serverPort}\n`);
  console.log(`✅ DocSync2 test server ready on port ${docsync2ServerPort}\n`);

  // Store the port in globalThis so tests can access it
  globalThis.__TEST_SERVER_PORT__ = serverPort;
  globalThis.__DOCSYNC2_TEST_SERVER_PORT__ = docsync2ServerPort;
  project.provide("testServerPort", serverPort);
  project.provide("docsync2TestServerPort", docsync2ServerPort);
}

export async function teardown() {
  if (server) await server.close();
  if (docsync2Server) await docsync2Server.close();
  console.log("✅ Test server stopped\n");
  console.log("✅ DocSync2 test server stopped\n");
}
