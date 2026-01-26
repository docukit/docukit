// Server unit tests - run in Node process for coverage
// (integration tests run server in globalSetup, excluded from coverage)

/* eslint-disable @typescript-eslint/no-empty-object-type */
import { describe, test, expect, expectTypeOf } from "vitest";
import { testWrapper } from "./utils.js";
import { DocSyncServer, InMemoryServerProvider } from "@docnode/docsync/server";
import { DocNodeBinding } from "@docnode/docsync/docnode";

describe("authentication", () => {
  test("rejects without token", async () => {
    const auth = { getToken: async () => "" };
    await testWrapper({ auth }, async (T) => {
      const error = await T.waitForError();
      expect(error.message).toContain("no token provided");
    });
  });

  test("rejects invalid token0", async () => {
    const auth = { getToken: async () => "test-token" };
    await testWrapper({ auth }, async (T) => {
      const error = await T.waitForError();
      expect(error.message).toContain("invalid token");
    });
  });

  test("accepts valid token", async () => {
    const auth = { getToken: async () => "valid-user1" };
    await testWrapper({ auth }, async (T) => {
      await T.waitForConnect();
      expect(T.socket.connected).toBe(true);
    });
  });
});

describe("sync-operations", () => {
  test("returns incremented clock", async () => {
    const auth = { getToken: async () => "valid-user1" };
    await testWrapper({ auth }, async (T) => {
      await T.waitForConnect();
      expect(T.socket.connected).toBe(true);
      const res = await T.syncOperations({
        docId: "doc-1",
        operations: [{ type: "insert" }],
        clock: 0,
      });

      expect("error" in res).toBe(false);
      if ("data" in res) {
        expect(res.data).toMatchObject({ docId: "doc-1", clock: 1 });
      }
    });
  });

  test("squashes operations after threshold", async () => {
    const auth = { getToken: async () => "valid-user1" };
    await testWrapper({ auth }, async (T) => {
      await T.waitForConnect();

      // Use a valid ULID for docId
      const docId = "01kfpgjsabrpdcw0qgh5evhy2g";

      // Send 100 operations individually
      for (let i = 0; i < 100; i++) {
        const res = await T.syncOperations({
          docId,
          operations: [{ type: "insert", data: `op-${i}` }],
          clock: i,
        });

        expect("error" in res).toBe(false);
        if ("data" in res) {
          expect(res.data.clock).toBe(i + 1);
        }
      }

      // First sync from clock 0: should receive all 100 operations
      const res1 = await T.syncOperations({
        docId,
        operations: [],
        clock: 0,
      });

      expect("error" in res1).toBe(false);
      if ("data" in res1) {
        expect(res1.data.clock).toBe(100);
        expect(res1.data.operations).toBeDefined();
        expect(res1.data.operations?.length).toBe(100);
        expect(res1.data.serializedDoc).toBeUndefined();
      }

      // Wait for squashing to complete (it happens async after the response)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second sync from clock 100: should receive serializedDoc (squashed)
      // because previous fetch triggered squashing (>= 100 operations)
      const res2 = await T.syncOperations({
        docId,
        operations: [],
        clock: 100,
      });

      expect("error" in res2).toBe(false);
      if ("data" in res2) {
        expect(res2.data.clock).toBe(100);
        expect(res2.data.serializedDoc).toBeDefined();
        expect(res2.data.operations).toBeUndefined();
      }
    });
  });
});

// ============================================================================
// Runtime Tests - Different function definition syntaxes with type inference
// ============================================================================

describe("authenticate/authorize: different function syntaxes", () => {
  test("method shorthand syntax: fn() { ... }", async () => {
    // Using method shorthand in object literal
    const server = new DocSyncServer({
      docBinding: DocNodeBinding([]),
      port: 0, // Let OS assign available port
      provider: InMemoryServerProvider,

      // Method shorthand - most concise
      async authenticate({ token }) {
        if (token === "valid-token") {
          return {
            userId: "user1",
            context: { role: "admin" as const, permissions: ["read", "write"] },
          };
        }
        return undefined;
      },

      async authorize(ev) {
        // Type inference should work - ev should have context with role and permissions
        return ev.context.role === "admin";
      },
    });

    // Verify type inference
    type InferredServer = typeof server;
    type InferredContext =
      InferredServer extends DocSyncServer<infer C, {}, {}, {}> ? C : never;

    expectTypeOf<InferredContext>().toEqualTypeOf<{
      role: "admin";
      permissions: string[];
    }>();

    expect(server).toBeInstanceOf(DocSyncServer);
    await server.close();
  });

  test("function expression syntax: fn: function() { ... }", async () => {
    // Using function keyword with property syntax
    const server = new DocSyncServer({
      docBinding: DocNodeBinding([]),
      port: 0, // Let OS assign available port
      provider: InMemoryServerProvider,

      // Traditional function expression
      authenticate: async function ({ token }) {
        if (token === "valid-token") {
          return {
            userId: "user2",
            context: { isAdmin: true, level: 5 },
          };
        }
        return undefined;
      },

      authorize: async function (ev) {
        // Type inference should work here too
        return ev.context.isAdmin && ev.context.level > 3;
      },
    });

    // Verify type inference
    type InferredServer = typeof server;
    type InferredContext =
      InferredServer extends DocSyncServer<infer C, {}, {}, {}> ? C : never;

    expectTypeOf<InferredContext>().toEqualTypeOf<{
      isAdmin: boolean;
      level: number;
    }>();

    expect(server).toBeInstanceOf(DocSyncServer);
    await server.close();
  });

  test("arrow function syntax: fn: () => { ... }", async () => {
    // Using arrow function
    const server = new DocSyncServer({
      docBinding: DocNodeBinding([]),
      port: 0, // Let OS assign available port
      provider: InMemoryServerProvider,

      // Arrow function - most common in modern code
      authenticate: async ({ token }) => {
        if (token === "valid-token") {
          return {
            userId: "user3",
            context: {
              tenantId: "tenant-123",
              features: ["feature-a", "feature-b"],
            },
          };
        }
        return undefined;
      },

      authorize: async (ev) => {
        // Type inference works perfectly with arrow functions
        return ev.context.tenantId.startsWith("tenant-");
      },
    });

    // Verify type inference
    type InferredServer = typeof server;
    type InferredContext =
      InferredServer extends DocSyncServer<infer C, {}, {}, {}> ? C : never;

    expectTypeOf<InferredContext>().toEqualTypeOf<{
      tenantId: string;
      features: string[];
    }>();

    expect(server).toBeInstanceOf(DocSyncServer);
    await server.close();
  });

  test("mixed syntaxes work together", async () => {
    const server = new DocSyncServer({
      docBinding: DocNodeBinding([]),
      port: 0, // Let OS assign available port
      provider: InMemoryServerProvider,

      // Method shorthand for authenticate
      async authenticate({ token }) {
        if (token === "mixed-token") {
          return {
            userId: "mixed-user",
            context: {
              org: "acme-corp",
              quota: 1000,
              flags: { beta: true, premium: false },
            },
          };
        }
        return undefined;
      },

      // Arrow function for authorize
      authorize: async (ev) => {
        return ev.context.quota > 500 && ev.context.flags.premium;
      },
    });

    // Verify complex nested type inference
    type InferredServer = typeof server;
    type InferredContext =
      InferredServer extends DocSyncServer<infer C, {}, {}, {}> ? C : never;

    expectTypeOf<InferredContext>().toEqualTypeOf<{
      org: string;
      quota: number;
      flags: { beta: boolean; premium: boolean };
    }>();

    expect(server).toBeInstanceOf(DocSyncServer);
    await server.close();
  });
});

// ============================================================================
// Type Tests - DocSyncServer assignability and variance
// ============================================================================

describe("DocSyncServer assignability", () => {
  test("specific context type is assignable to unknown context", () => {
    void (() => {
      // Server with specific context type
      const specificServer = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          if (_token === "test") {
            return {
              userId: "user1",
              context: { role: "admin" as const, level: 5 },
            };
          }
          return undefined;
        },
      });

      type SpecificServer = typeof specificServer;
      type GenericServer = DocSyncServer<unknown, {}, {}, {}>;

      // Specific server should be assignable to server with unknown context
      expectTypeOf<SpecificServer>().toMatchTypeOf<GenericServer>();

      // But not the other way around
      expectTypeOf<GenericServer>().not.toMatchTypeOf<SpecificServer>();

      void specificServer.close();
    });
  });

  test("narrow context is assignable to wider context", () => {
    void (() => {
      // Server with narrow literal types
      const _narrowServer = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          return {
            userId: "user1",
            context: {
              role: "admin" as const, // literal type
              permissions: ["read", "write"] as const, // readonly tuple
            },
          };
        },
      });

      type NarrowServer = typeof _narrowServer;

      // Should be assignable to server with wider types
      type WiderServer = DocSyncServer<
        { role: string; permissions: readonly string[] },
        {},
        {},
        {}
      >;

      expectTypeOf<NarrowServer>().toMatchTypeOf<WiderServer>();
    });
  });

  test("server with optional authorize is assignable to server requiring authorize", () => {
    void (() => {
      // Server without authorize
      const serverWithoutAuth = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          return { userId: "user1", context: { premium: true } };
        },
      });

      // Server with authorize
      const serverWithAuth = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          return { userId: "user1", context: { premium: true } };
        },
        async authorize(ev) {
          return ev.context.premium;
        },
      });

      type ServerWithoutAuth = typeof serverWithoutAuth;
      type ServerWithAuth = typeof serverWithAuth;

      // Both should be assignable to the base type
      type BaseServer = DocSyncServer<{ premium: boolean }, {}, {}, {}>;

      expectTypeOf<ServerWithoutAuth>().toMatchTypeOf<BaseServer>();
      expectTypeOf<ServerWithAuth>().toMatchTypeOf<BaseServer>();

      void serverWithoutAuth.close();
      void serverWithAuth.close();
    });
  });

  test("complex nested context types maintain assignability", () => {
    void (() => {
      const complexServer = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          return {
            userId: "user1",
            context: {
              org: {
                id: "org-123",
                name: "ACME Corp",
                tier: "enterprise" as const,
              },
              user: {
                roles: ["admin", "developer"] as const,
                flags: {
                  beta: true,
                  experimental: false,
                },
              },
            },
          };
        },
      });

      type ComplexServer = typeof complexServer;

      // Should be assignable to server with simplified nested structure
      type SimplifiedServer = DocSyncServer<
        {
          org: { id: string; name: string; tier: string };
          user: { roles: readonly string[]; flags: Record<string, boolean> };
        },
        {},
        {},
        {}
      >;

      expectTypeOf<ComplexServer>().toMatchTypeOf<SimplifiedServer>();

      // And also to very generic structure
      type VeryGenericServer = DocSyncServer<
        { org: object; user: object },
        {},
        {},
        {}
      >;

      expectTypeOf<ComplexServer>().toMatchTypeOf<VeryGenericServer>();

      void complexServer.close();
    });
  });

  test("empty context {} is assignable to unknown", () => {
    void (() => {
      const emptyContextServer = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          return { userId: "user1" }; // No context
        },
      });

      type EmptyContextServer = typeof emptyContextServer;
      type UnknownContextServer = DocSyncServer<unknown, {}, {}, {}>;

      // Empty context should be assignable to unknown
      expectTypeOf<EmptyContextServer>().toMatchTypeOf<UnknownContextServer>();

      void emptyContextServer.close();
    });
  });

  test("type inference preserves literal types", () => {
    void (() => {
      const literalServer = new DocSyncServer({
        docBinding: DocNodeBinding([]),
        port: 0, // Let OS assign available port
        provider: InMemoryServerProvider,
        async authenticate({ token: _token }) {
          return {
            userId: "user1",
            context: {
              // Using 'as const' to preserve literal types
              status: "active" as const,
              plan: "pro" as const,
              features: ["feature-a", "feature-b", "feature-c"] as const,
            },
          };
        },
      });

      type LiteralServer = typeof literalServer;
      type ExtractedContext =
        LiteralServer extends DocSyncServer<infer C, {}, {}, {}> ? C : never;

      // Verify literal types are preserved
      expectTypeOf<ExtractedContext>().toEqualTypeOf<{
        status: "active";
        plan: "pro";
        features: readonly ["feature-a", "feature-b", "feature-c"];
      }>();

      // But also assignable to wider types
      expectTypeOf<ExtractedContext>().toMatchTypeOf<{
        status: string;
        plan: string;
        features: readonly string[];
      }>();

      void literalServer.close();
    });
  });

  test("DocSyncServer<C,D,S,O> is assignable to DocSyncServer (base type)", () => {
    // Specific DocSyncServer with all type parameters should be assignable to base DocSyncServer
    type SpecificServer = DocSyncServer<
      { role: string; permissions: string[] },
      { root: unknown },
      { root: unknown },
      { type: string }
    >;

    expectTypeOf<SpecificServer>().toExtend<DocSyncServer>();
  });
});
