import { vi } from "vitest";
import { io, type Socket } from "socket.io-client";
import type { ServerProvider } from "../../../packages/docsync/src/server/types.js";

// ============================================================================
// Port Management
// ============================================================================

let portCounter = 0;
const basePort = 10000 + parseInt(process.env.VITEST_POOL_ID ?? "0") * 100;

export const getUniquePort = () => basePort + portCounter++;

// ============================================================================
// Mock Provider
// ============================================================================

type SerializedDoc = { content: string };
type Operations = { op: string }[];

export type MockProviderInstance = ServerProvider<SerializedDoc, Operations> & {
  syncSpy: ReturnType<typeof vi.fn>;
};

export const createMockProvider = () => {
  const syncSpy = vi.fn();

  class MockProvider implements ServerProvider<SerializedDoc, Operations> {
    syncSpy = syncSpy;

    async sync(req: {
      docId: string;
      operations: Operations[] | null;
      clock: number;
    }) {
      syncSpy(req);
      return {
        docId: req.docId,
        operations: null,
        serializedDoc: { content: "synced" },
        clock: req.clock + 1,
      };
    }
  }

  return { MockProvider, syncSpy };
};

// ============================================================================
// Server Config Factory
// ============================================================================

export const createServerConfig = (overrides: { port?: number } = {}) => {
  const { MockProvider, syncSpy } = createMockProvider();
  return {
    config: {
      port: overrides.port ?? getUniquePort(),
      provider: MockProvider,
      authenticate: vi.fn(async () => ({ userId: "auth-user" })),
    },
    syncSpy,
  };
};

// ============================================================================
// Client Factory
// ============================================================================

export const createClient = (port: number): Socket => {
  return io(`ws://localhost:${port}`, {
    auth: { userId: "test-user", token: "test-token" },
  });
};

// ============================================================================
// Cleanup Helpers
// ============================================================================

export const closeServer = (server: { ["_io"]: { close: () => void } }) => {
  server["_io"].close();
};

export const disconnectClient = (client: Socket) => {
  if (client.connected) {
    client.disconnect();
  }
};
