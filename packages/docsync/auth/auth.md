# DocSync Authentication Model

DocSync does not implement authentication. It defines hooks so an application
can authenticate WebSocket connections while DocSync focuses on synchronization.

## Core Principles

- DocSync never issues credentials.
- DocSync never refreshes credentials.
- DocSync never persists credentials.
- DocSync treats authentication as a connection concern.
- DocSync does not generate, store, or send encryption keys.

## Client Auth Modes

Browser apps with an existing `HttpOnly` session cookie should usually use
request auth:

```ts
createDocSyncClient({ server: { url, auth: { mode: "request" } } });
```

The browser includes matching cookies in the WebSocket handshake. JavaScript
does not need to read the session secret.

Use token auth when the client already has a safe token to present:

```ts
createDocSyncClient({
  server: {
    url,
    auth: { mode: "token", getToken: async () => authStore.accessToken },
  },
});
```

`getToken` is called on connection and reconnection in token mode. DocSync does
not call it per operation.

## Server Auth

`authenticate` receives the real handshake request and an optional token:

```ts
type AuthenticateInput = { request: IncomingMessage; token?: string };

type AuthenticateResult<TContext> = { userId: string; context?: TContext };
```

Example:

```ts
authenticate: async ({ request, token }) => {
  // Authenticate via request, commonly with cookies.
  const cookieIdentity = await getCookieIdentity(request.headers);
  if (cookieIdentity) return { userId: cookieIdentity.userId };

  // Or authenticate via token.
  if (token) return getTokenIdentity(token);

  return undefined;
};
```

The returned `userId` is required. DocSync uses it for socket identity,
presence, authorization events, sync events, logs, and local storage namespace
selection. `context` is opaque application data passed to `authorize`.

## Local Identity

DocSync stores the last server-verified `userId` in `localStorage` under
`docsync:localUserId`.

That value is only a local startup hint. It does not authenticate the user.

1. If DocSync has a cached verified `userId`, it opens the local provider with
   that user ID.
2. DocSync sends that value as an internal `claimedUserId` in the WebSocket
   handshake.
3. `claimedUserId` is not passed to the public `authenticate` callback.
4. The server authenticates from the request and optional token.
5. If the authenticated `userId` differs from `claimedUserId`, the server
   rejects the connection.
6. If there is no cached identity, DocSync waits for the server `identity` event
   before opening local storage.

DocSync does not switch users inside a live client instance. Logout/login should
create a new `DocSyncClient` through navigation, unmounting, or app-level
recreation.

Offline-capable web apps should call `client.clearLocalIdentity()` when the app
logs out:

```ts
async function logout() {
  client.clearLocalIdentity();

  await authClient.signOut().catch(() => {
    // Offline logout: DocSync local identity was still cleared.
  });
}
```

`clearLocalIdentity()` only clears DocSync's local identity cache. It does not
log out Better Auth, NextAuth, Clerk, or any other auth library. It does not
clear IndexedDB, reset the live client, or disconnect the socket.

## Authorization

Authentication answers who the connection is. Authorization answers what the
authenticated user may do.

```ts
authorize: async ({ type, req, userId, context }) => {
  if (type === "sync") {
    return await canUserAccessDoc(userId, req.docId, context.orgId);
  }

  return true;
};
```

DocSync does not impose roles, ACLs, sharing, or permission models. The
application owns those decisions.

### IndexedDB Namespacing Strategy

For multi-user local persistence, three architectural options were evaluated:

1. **Separate databases per user** – One IndexedDB database per userId
2. **Separate object stores per user** – Single database, one object store per userId
3. **Single object store with userId** – All users share one store, records include a userId field

Performance benchmarks were conducted comparing write throughput, read latency, data scaling behavior, and user switching costs.

Results consistently showed:

**Separate databases > Separate object stores > Single object store**

DocSync uses **separate databases per user** for local persistence.

## Encryption

Encryption is outside DocSync auth.

- Local encryption belongs in a custom or wrapped `ClientProvider`.
- Server-side encryption belongs in the `ServerProvider`.
- End-to-end encryption belongs in an application-managed payload/key layer.

DocSync should remain compatible with encrypted payloads, but key creation,
storage, recovery, rotation, revocation, and multi-device sharing are
application responsibilities.
