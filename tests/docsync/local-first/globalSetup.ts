/**
 * Vitest globalSetup for integration tests.
 * Starts a DocSyncServer with InMemoryServerProvider before browser tests run.
 *
 * Uses @docnode/docsync/testing to avoid loading PostgresProvider which requires DB env vars.
 */
import {
  DocSyncServer,
  InMemoryServerProvider,
} from "@docnode/docsync/testing";

const TEST_PORT = 8082;

/**
 * Test token format: "test-token-{userId}"
 * This allows tests to authenticate as different users.
 */
const parseTestToken = (token: string): string | undefined => {
  const prefix = "test-token-";
  if (!token.startsWith(prefix)) return undefined;
  return token.slice(prefix.length);
};

let server: DocSyncServer<unknown, unknown, unknown> | undefined;

export async function setup() {
  server = new DocSyncServer({
    port: TEST_PORT,
    provider: InMemoryServerProvider,
    authenticate: async ({ token }) => {
      const userId = parseTestToken(token);
      if (!userId) return undefined;
      return { userId };
    },
  });

  // Give the server a moment to start
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`✅ Test server ready on port ${TEST_PORT}\n`);
}

export async function teardown() {
  if (server) await server.close();
  console.log("✅ Test server stopped\n");
}
