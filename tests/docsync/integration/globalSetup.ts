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

let server: DocSyncServer<unknown, unknown, unknown> | undefined;

export async function setup() {
  console.log(`\n🚀 Starting test server on port ${TEST_PORT}...`);

  server = new DocSyncServer({
    port: TEST_PORT,
    provider: InMemoryServerProvider,
    authenticate: async () => ({ userId: "test-user" }),
  });

  // Give the server a moment to start
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`✅ Test server ready on port ${TEST_PORT}\n`);
}

export async function teardown() {
  console.log("\n🛑 Stopping test server...");
  if (server) {
    await server.close();
  }
  console.log("✅ Test server stopped\n");
}
