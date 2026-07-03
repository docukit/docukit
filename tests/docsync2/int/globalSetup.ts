/**
 * Vitest globalSetup for DocSync2 integration tests.
 * Starts a DocSync2 server only for tests that need DocSync2 networking.
 */
import type { JsonDoc, Operations } from "@docukit/docnode";
import { DocNodeValidators } from "@docukit/docsync2/docnode";
import {
  DocSyncServer,
  inMemoryServerProvider,
} from "@docukit/docsync2/server";
import { createServer } from "node:net";
import type { TestProject } from "vitest/node";

const PREFERRED_PORT = 8083;
const UNAUTHORIZED_DOC_ID = "01j00000000000000000000000";

declare module "vitest" {
  export interface ProvidedContext {
    docsync2TestServerPort: number;
  }
}

declare global {
  var __DOCSYNC2_TEST_SERVER_PORT__: number | undefined;
}

async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
    server.listen(startPort, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to find available DocSync2 test port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

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

export async function setup(project: TestProject) {
  serverPort = await findAvailablePort(PREFERRED_PORT);

  server = new DocSyncServer({
    validators: DocNodeValidators(),
    port: serverPort,
    provider: inMemoryServerProvider<JsonDoc, Operations>(),
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

  await new Promise((resolve) => setTimeout(resolve, 10));
  console.log(`✅ DocSync2 test server ready on port ${serverPort}\n`);

  globalThis.__DOCSYNC2_TEST_SERVER_PORT__ = serverPort;
  project.provide("docsync2TestServerPort", serverPort);
}

export async function teardown() {
  if (server) await server.close();
  console.log("✅ DocSync2 test server stopped\n");
}
