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

DocSync supports two client auth modes.

For normal browser apps with an existing `HttpOnly` session cookie, prefer
request auth:

```ts
createDocSyncClient({ server: { url, auth: { mode: "request" } } });
```

Request auth means the server authenticates from the WebSocket handshake
request. In browsers, the common case is an `HttpOnly` session cookie sent by
the browser during the handshake. JavaScript does not need to read the session
secret, and DocSync does not need an extra token request.

Same-origin setups are the easiest path. Cross-origin cookie sessions can also
work, but the application must configure cookie domain, `SameSite`, `Secure`,
and credential/CORS settings correctly.

Use token auth when the client already has a safe token to present, or when
cookies are not the right tool:

```ts
createDocSyncClient({
  server: {
    url,
    auth: { mode: "token", getToken: async () => authStore.accessToken },
  },
});
```

If a browser app stores its main session in an `HttpOnly` cookie and DocSync
requires a JavaScript-readable token, the app usually needs either:

- an extra request to exchange the cookie-backed session for a sync token; or
- a server-rendered bootstrap that embeds a sync token in the initial page.

The bootstrap path avoids an extra request, but the sync token is readable by
JavaScript. For most browser apps with `HttpOnly` session cookies, request auth
is the recommended pattern.

### Client Configuration

```ts
type ClientAuthConfig =
  | { mode: "request" }
  | { mode: "token"; getToken: () => MaybePromise<string> };

export type ClientConfig = {
  docBinding: DocBinding;
  server: { url: string; auth: ClientAuthConfig };
  local: {
    /**
     * Resolves the local storage identity.
     *
     * Used exclusively for:
     * - Namespacing local persistence (userId)
     * - Deriving encryption keys for data at rest (secret)
     *
     * This is NOT authentication and is not authoritative.
     */
    getIdentity: () => Promise<{ userId: string; secret: string }>;

    provider: (identity: Identity) => ClientProvider;
  };
};
```

---

### When `getToken` Is Called

`getToken` is only used in token mode.

- On initial WebSocket connection
- On reconnection after disconnect

DocSync does **not** call `getToken` per operation.

In request mode, DocSync does not call `getToken` at all. The server receives
the real handshake request and can authenticate cookies, headers, or other
request-level credentials.

---

## Server-Side Authentication

### Server Configuration

```ts
export type ServerConfig<TContext = {}> = {
  port?: number;
  provider: ServerProvider;

  /**
   * Authenticates a WebSocket connection.
   *
   * - Called once per connection attempt.
   * - Can validate cookies from the handshake request.
   * - Can validate an optional token.
   * - Must resolve the canonical userId.
   * - May optionally return a context object passed to authorize.
   */
  authenticate: (ev: {
    request: IncomingMessage;
    token?: string;
  }) => Promise<{ userId: string; context?: TContext } | undefined>;

  /**
   * Authorizes an operation (get-doc, sync, delete-doc).
   * Receives cached context from authenticate.
   */
  authorize?: (ev: AuthorizeEvent<TContext>) => Promise<boolean>;
};
```

### Authentication Lifecycle

Authentication is **connection-level**, not per-operation.

Flow:

1. Client establishes a WebSocket connection
2. Browser cookies are included in the WebSocket handshake when applicable
3. Token clients provide a token via `auth.getToken()`
4. Server calls `authenticate({ request, token })`
5. Server resolves `{ userId, context? }`
6. Identity is attached to the socket
7. Operations are accepted while the connection is trusted

If authentication fails, the connection is rejected immediately.

Recommended server pattern:

```ts
authenticate: async ({ request, token }) => {
  // Authenticate via request, commonly with cookies.
  const cookieIdentity = await getCookieIdentity(request.headers);
  if (cookieIdentity) return cookieIdentity;

  // Or authenticate via token.
  if (token) return getTokenIdentity(token);

  return undefined;
};
```

This keeps the browser path fast and secure while preserving token support for
non-browser clients, scoped document grants, tests, CLIs, workers, mobile apps,
and server-to-server sync.

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
      type: "sync";
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
authenticate: async ({ request, token }) => {
  // Authenticate via request, commonly with cookies.
  const user = await getUserFromCookie(request.headers);
  if (user) {
    return {
      userId: user.id,
      context: { roles: user.roles }, // cached at connection time
    };
  }

  // Or authenticate via token.
  if (!token) return undefined;

  const tokenUser = await getUserFromToken(token);
  if (!tokenUser) return undefined;

  return {
    userId: tokenUser.id,
    context: { roles: tokenUser.roles },
  };
},

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

The local storage namespace is derived from the **server-resolved userId**, not
from a client claim, cookie value, or token value.

Flow:

1. Client connects with request auth or token auth
2. `authenticate` validates the request and optional token
3. `authenticate` resolves `{ userId }`
4. The resolved `userId` is returned to the client
5. Local persistence is initialized using that `userId` as a namespace

Example:

```ts
IndexedDB name = `DocSync:${userId}`
```

This ensures:

- Tokens, cookies, and sessions may rotate or expire without affecting local data
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

- Browser cookies or a token are provided during connection
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

DocSync treats cookies and tokens as **opaque**.

It does not parse tokens, infer expiry, refresh credentials, or poll the auth
provider. The application owns session refresh, token rotation, and revocation.

### Token Expiry Handling

There are two possible future strategies.

#### 1) Authoritative Expiry (`expiresAt`)

If `authenticate` eventually returns `expiresAt`, DocSync could schedule a
disconnect exactly at that time.

- The server would schedule a disconnect with `setTimeout`
- No periodic revalidation would be performed
- The next connection would run the normal handshake again

This is the simplest path when the auth system knows the credential TTL, such as
a JWT `exp` claim or a session expiration timestamp.

#### 2) In-Place Reauthentication Event

DocSync could add an internal event, for example `refresh-auth`, that lets token
clients send a fresh token without closing the socket.

- The client would call `auth.getToken()` again before expiry
- The server would re-run `authenticate`
- The server would update `socket.data.context` if the same `userId` is returned
- The server would disconnect the socket if refresh fails or changes users

This is more complex, but avoids a real disconnect for token auth.

<!-- TODO: Evaluate this on demand. The two realistic implementation paths are
`expiresAt` + `setTimeout` disconnect/reconnect, or an in-place `refresh-auth`
event. The event path only works for token auth; it does not work for request
auth because an already-open WebSocket does not receive fresh request headers or
updated cookie headers. Request auth needs a new handshake to observe current
request credentials. -->

### Current Userland Pattern

DocSync does **not** currently provide built-in `expiresAt`,
`authRevalidation.intervalMs`, or a `refresh-auth` event.

Applications that already know when credentials expire can schedule a reconnect
themselves:

```ts
function reconnectDocSyncBeforeExpiry(expiresAtMs: number) {
  const reconnectMs = Math.max(0, expiresAtMs - Date.now() - 5_000);

  window.setTimeout(() => {
    client.disconnect();
    client.connect();
  }, reconnectMs);
}
```

On reconnect:

- Pending operations remain local
- Token auth calls `auth.getToken()` again
- Request auth sends matching request credentials again in the new handshake
- The server calls `authenticate({ request, token })` again

This works with:

- short-lived access tokens
- rotated tokens
- long-lived cookie sessions
- revoked sessions, once the app or transport forces a reconnect

For stricter per-operation checks, applications can also use `authorize`, but
that is authorization, not reauthentication. It can reject an operation after a
session is revoked, but it does not refresh credentials or update the
connection's authenticated context.

For most apps, request auth plus normal session handling is the recommended
browser pattern. Token auth remains the recommended pattern for non-browser
clients and scoped grants.

---

## Security Model Summary

- Tokens are **presented**, not derived
- Cookies are **sent by the browser**, not read by DocSync client JavaScript
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
