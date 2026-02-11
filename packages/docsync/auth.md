# DocSync – Authentication Model

This document describes how authentication works in **DocSync**.

DocSync does **not** implement authentication itself. Instead, it defines clear extension points so applications can plug in their own auth system while DocSync focuses strictly on synchronization.

DocSync provides **authentication and authorization hooks**, but it does not impose any model for authentication (JWT, OAuth, API keys) or authorization (ACLs, sharing, roles).

---

## Core Principles

- DocSync **never issues credentials**.
- DocSync **never refreshes credentials**.
- DocSync **never persists credentials**.
- DocSync treats authentication as a **connection concern**, not a business concern.

If your app can authenticate users today, it can authenticate DocSync.

---

## Authentication vs Authorization

DocSync makes a strict distinction:

- **Authentication**: Who is this connection?
- **Authorization**: What is this user allowed to do?

DocSync only defines **authentication**.
Authorization (document sharing, ACLs, permissions) is intentionally left to the application layer.

---

## Client-Side Authentication

### Client Configuration

````ts
export type ClientConfig = {
  url: string;
  userId: string;
  docConfigs: DocConfig[];
  auth: {
    /**
     * Server authentication token.
     *
     * - Passed verbatim to the server on connection.
     * - Validation is delegated to the server via `authenticate`.
     * - This library does not issue, refresh, rotate, or persist tokens.
     *
     * `getToken` is expected to be a **cheap read** from existing auth state, not a network login flow.
     *
     * @example
     * ```
     * auth: {
     *   getToken: async () => authStore.accessToken
     * }
     * ```
     */
    getToken: () => Promise<string>;
  };
  local?: {
    /**
     * Resolves the local storage identity.
     *
     * Used exclusively for:
     * - Namespacing local persistence (userId)
     * - Deriving encryption keys for data at rest (secret)
     *
     * This is NOT authentication and is not authoritative.
     */
    getIdentity: () => Promise<{
      userId: string;
      secret: string;
    }>;

    provider: new () => Provider;
  };
};
````

---

### When `getToken` Is Called

- On initial WebSocket connection
- On reconnection after disconnect

DocSync does **not** call `getToken` per operation.

---

## Server-Side Authentication

### Server Configuration

```ts
export type ServerConfig<TContext = {}> = {
  port?: number;
  provider: new () => ServerProvider;

  /**
   * Authenticates a WebSocket connection.
   *
   * - Called once per connection attempt.
   * - Must validate the provided token.
   * - Must resolve the canonical userId.
   * - May optionally return a context object passed to authorize.
   */
  authenticate: (ev: { token: string }) => Promise<
    | {
        userId: string;
        context?: TContext;
      }
    | undefined
  >;

  /**
   * Authorizes an operation (get-doc, sync-operations, delete-doc).
   * Receives cached context from authenticate.
   */
  authorize?: (ev: AuthorizeEvent<TContext>) => Promise<boolean>;

  /**
   * Optional revalidation policy used when `expiresAt` is not provided.
   */
  authRevalidation?: {
    intervalMs?: number; // default: 30_000
  };
};
```

### Authentication Lifecycle

Authentication is **connection-level**, not per-operation.

Flow:

1. Client establishes a WebSocket connection
2. Client provides a token via `auth.getToken()`
3. Server calls `authenticate(token)`
4. Server resolves `{ userId, expiresAt? }`
5. Identity is attached to the socket
6. Operations are accepted while the connection is trusted

If authentication fails, the connection is rejected immediately.

---

## Authorization

DocSync provides authorization hooks but **does not impose any model**. The app decides how to authorize.

### Authorize Events

Each operation has its own typed payload:

```ts
type AuthorizeEvent<TContext> =
  | {
      type: "get-doc";
      payload: { docId: string };
      userId: string;
      context: TContext;
    }
  | {
      type: "sync-operations";
      payload: { docId: string; operations: O };
      userId: string;
      context: TContext;
    }
  | {
      type: "delete-doc";
      payload: { docId: string };
      userId: string;
      context: TContext;
    };
```

### Context: Cached vs Fresh

`authenticate` can return a `context` that's cached and passed to `authorize`:

```ts
authenticate: async ({ token }) => ({
  userId: user.id,
  context: { roles: user.roles }, // cached at connection time
}),

authorize: async ({ type, userId, context }) => {
  // Option 1: Use cached context (fast, might be stale)
  if (context.roles.includes("admin")) return true;

  // Option 2: Fetch fresh data (slower, always consistent)
  const freshUser = await db.getUser(userId);
  return freshUser.roles.includes("editor");
},
```

**The tradeoff:** Cached context is fast but might be stale if roles change mid-session. Fetching fresh data is always consistent but slower. The app decides based on their needs.

---

## Why `userId` Is Derived Server-Side

The client may claim a `userId`, but the server is authoritative.

Reasons:

- Prevents identity spoofing
- Matches real-world auth systems (JWT `sub`, sessions, API keys)
- Keeps trust boundaries explicit

The resolved `userId` is attached to the connection context and used for all subsequent operations.

---

## Local Persistence and Authentication

Local persistence **does not authenticate users** and **does not authorize operations**.

It exists only to:

- Partition local data
- Encrypt data at rest

Local persistence never validates identity and never calls `getToken`.

### How the Local Namespace Is Chosen

The local storage namespace is derived from the **server-resolved userId**, not from the token.

Flow:

1. Client obtains a token via `auth.getToken()`
2. Token is sent to the server
3. `authenticate` validates the token and resolves `{ userId }`
4. The resolved `userId` is returned to the client
5. Local persistence is initialized using that `userId` as a namespace

Example:

```ts
IndexedDB name = `DocSync:${userId}`
```

This ensures:

- Tokens may rotate or expire without affecting local data
- Local data is correctly partitioned per account
- Identity authority remains server-side

### Why This Does NOT Violate “Local Has No Auth”

Local persistence is **namespacing**, not authentication.

- Authentication answers: "Who are you, according to an authority?"
- Namespacing answers: "Which local bucket should I use?"

Local storage does not verify the userId. It simply trusts the application to pass one.

If the application passes an incorrect userId, local storage will still function. This is expected behavior.

There is no security boundary locally. The boundary exists only at the server.

### IndexedDB Namespacing Strategy

For multi-user local persistence, three architectural options were evaluated:

1. **Separate databases per user** – One IndexedDB database per userId
2. **Separate object stores per user** – Single database, one object store per userId
3. **Single object store with userId** – All users share one store, records include a userId field

Performance benchmarks were conducted comparing write throughput, read latency, data scaling behavior, and user switching costs.

Results consistently showed:

**Separate databases > Separate object stores > Single object store**

DocSync uses **separate databases per user** for local persistence.

### Local Encryption Secret Management (Recommended Pattern)

DocSync does not manage encryption secrets. However, for most applications, the following **server-backed secret** flow is recommended, as it provides good security, excellent UX, and optimal Core Web Vitals (CWV).

#### Secret Creation (Server)

- When a user account is created, the server generates a **high-entropy random secret**.
- This secret is **never stored in plaintext**.
- The server stores the secret **encrypted under the user’s authentication credentials**, for example:
  - encrypted with a key derived from OAuth credentials
  - encrypted with a password-derived key
  - protected by the identity provider’s security guarantees

This ensures that a database leak alone does not expose local encryption keys.

#### First Login on a Device

On the first login from a new device:

1. The client authenticates normally with the server
2. The server decrypts and returns the user’s local encryption secret
3. The client derives its local encryption keys and initializes persistence
4. The secret is stored **locally in secure storage**, preferably:
   - a secure cookie
   - using app-bound encryption if supported by the browser

The cookie expiration should match the desired **local session lifetime**. In many applications this may be very long or effectively indefinite.

#### Subsequent App Starts (Fast Path)

On later startups:

1. The client attempts to read the secret from secure local storage
2. If found, local persistence is initialized immediately
3. UI renders from local data without waiting for network calls
4. Authentication and synchronization proceed in the background

This avoids an additional roundtrip to the server and preserves fast startup and good CWV.

---

### Convenience Helpers (Recommended)

While DocSync keeps secret management application-defined, it is recommended to provide **official helper utilities** for common setups.

For example, a server-backed secret helper can encapsulate best practices:

```ts
import { serverBackedSecret } from "@docukit/auth-helpers";

local: {
  getIdentity: serverBackedSecret({
    fetchSecret: () => fetch("/DocSync/secret"),
    storage: "secure-cookie",
    cookieTtlDays: 365,
  }),
}
```

Such helpers:

- Fetch the secret once after authentication
- Store it in secure local storage (e.g. secure cookies with app-bound encryption when available)
- Reuse the locally stored secret on subsequent startups
- Avoid unnecessary network roundtrips

This provides a batteries-included path for most users while keeping the DocSync core minimal, flexible, and honest about its security boundaries.

For most applications, this trade-off provides the best balance between security, usability, and performance.

Authentication and encryption are intentionally separate.

---

## Offline and Online Behavior

### Online

- Token is provided
- Server authenticates
- `userId` is resolved
- Sync proceeds normally

### Offline

- Local persistence may continue (if configured)
- No authentication occurs
- Sync resumes when connection is re-established

DocSync does not attempt to validate identity while offline.

---

## Token Expiry, Revalidation, and Disconnects

DocSync treats tokens as **opaque**.

It does not parse tokens, infer expiry, or manage refresh.

### Token Expiry Handling

There are two supported strategies:

#### 1) Authoritative Expiry (`expiresAt`)

If `authenticate` returns `expiresAt`:

- The server schedules a disconnect exactly at that time
- No periodic revalidation is performed
- This is the most efficient path

This is strongly recommended when the auth system knows the token TTL (e.g. JWT `exp`).

#### 2) Defensive Revalidation (Polling)

If `expiresAt` is **not** provided:

- DocSync periodically re-calls `authenticate`
- If authentication fails, the socket is disconnected
- The interval is controlled via `authRevalidation.intervalMs`

This is required for:

- opaque tokens
- manually revocable sessions
- external identity providers

### Why These Are Different

- `expiresAt` represents **authoritative knowledge**: a guaranteed upper bound.
- Revalidation represents **uncertainty management**: checking in case revocation occurred.

They may be implemented with similar timers internally, but they have different semantics and guarantees.

### Client Reconnection

When a socket is disconnected (e.g. due to token expiry):

- Pending operations remain local
- Socket.IO reconnects automatically
- `auth.getToken()` is called again
- A new authenticated connection is established

This ensures DocSync works correctly with:

- short-lived tokens
- refresh and rotation
- long-lived sessions

### Proactive Token Refresh (Optional)

By default, DocSync relies on **disconnect + reconnect** when a token expires.

If an application wanted to update a token **without losing the connection**, an explicit re-authentication flow could be implemented on DocSync (for example, a custom `refresh_auth` event that re-executes `authenticate` and reschedules the expiration).

However, this event is not supported in DocSync, at least not at the moment. Reconnection happens very quickly, so this procedure doesn't seem worthwhile.

---

## Security Model Summary

- Tokens are **presented**, not derived
- Secrets are **derived**, not presented
- Authentication happens per connection
- Authorization is application-defined

---

## Design Intent

DocSync’s auth model is deliberately minimal.

This allows it to:

- Work with any auth system
- Avoid security assumptions
- Remain stable as applications evolve

If you need more than this, DocSync is intentionally not the place to add it.
