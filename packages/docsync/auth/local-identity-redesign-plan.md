# DocSync Auth + Offline Identity Redesign

## Summary

Redesign DocSync so users no longer provide `getIdentity`, `userId`, or secret
management. The app still provides `local.provider`, so tree-shaking stays
explicit, but DocSync owns the verified identity and local secret flow.

## Public API

Keep `local.provider` required:

```ts
new DocSyncClient({
  docBinding,
  server: { url, auth: { mode: "request" } },
  local: { provider: indexedDBProvider },
});
```

Remove `local.getIdentity`. Do not add `local: false`; memory-only mode breaks
the normal offline and cross-tab model.

Server auth returns identity plus the server-backed local secret:

```ts
type AuthenticateResult<TContext> = {
  userId: string;
  context?: TContext;
  localEncryptionSecret?: string;
};
```

`localEncryptionSecret` is optional in the type for migration, but encrypted
offline persistence requires either a cached secret or a secret returned by the
server.

## Correct Flow

First login on a device:

1. Client has no cached verified identity.
2. Client connects online with request auth or token auth.
3. Server authenticates from `request` or `token`.
4. Server returns `{ userId, localEncryptionSecret }` from `authenticate`.
5. Server emits `identity` to the client immediately after successful auth.
6. Client stores `{ userId, localEncryptionSecret }` internally.
7. Client opens `local.provider` using the verified `userId`.
8. Offline persistence is enabled only if a secret exists.

Subsequent app start with cached identity:

1. Client reads cached `{ userId, localEncryptionSecret }` first.
2. If both exist, client opens `local.provider` immediately.
3. UI can render from local data before network auth completes.
4. Client connects in the background and sends `claimedUserId`.
5. Server authenticates and emits authoritative `identity`.
6. If server `userId` matches cached `userId`, continue normally.
7. If server `userId` differs, close the old provider, open the verified
   namespace, and never sync old local operations under the new user. Pending
   operations from the cached user stay in the old namespace so they can only be
   synced if that same user is verified again later.

Offline refresh:

1. Client reads cached `{ userId, localEncryptionSecret }`.
2. If found, local persistence starts without contacting the server.
3. Sync stays paused until connection returns.
4. No authentication happens offline.

No cached identity:

- If online, wait for server `identity` before opening persistent local storage.
- If offline, persistent local storage cannot start.
- If server authenticates but does not provide `localEncryptionSecret`, DocSync
  may sync online but must not enable encrypted offline persistence for that
  user.

## Implementation Details

- `claimedUserId` is only a hint from cached local state.
- The server never trusts `claimedUserId` for auth.
- The server-resolved `userId` is authoritative.
- DocSync handles `claimedUserId` internally and does not expose it to
  `authenticate`.
- The client must not generate `localEncryptionSecret` by default.
- The server should generate the secret with high entropy, store it encrypted
  under real user credentials, and return it after successful auth.
- DocSync stores only server-verified identity records.
- If cached and verified identities differ, DocSync clears runtime state and
  opens the verified namespace. It does not delete, migrate, or sync pending
  operations from the old namespace under the new user.
- DocSync prefers JS-readable secure cookies for the local secret, following the
  Y-Sweet approach. Do not use `HttpOnly` because the client must read the
  secret to decrypt IndexedDB.
- Built-in IndexedDB persistence namespaces by verified/cached `userId` and
  encrypts serialized docs and operation batches with AES-GCM.

## Y-Sweet Research Incorporated

- The cookie storage choice is based on the Browsertech Digest article
  ["Encrypting offline storage for local-first apps"](https://buttondown.com/browsertech/archive/browsertech-digest-encrypting-offline-storage-for/),
  which explains why Y-Sweet stores the local encryption key in a cookie while
  storing encrypted document data in IndexedDB.
- Y-Sweet PR #354 adds offline support with AES-GCM encrypted IndexedDB and
  cookie-stored keys.
- Y-Sweet exposes a simple offline feature instead of making users manage key
  storage.
- The PR discussion chose cookies because browsers often protect cookies more
  than IndexedDB on disk.
- Y-Sweet PR #360 shows offline state should not rely only on WebSocket close
  timing; DocSync should keep "local ready" separate from "sync connected".

## Test Plan

- request auth sends `claimedUserId` only when cached.
- token auth sends `token` plus cached `claimedUserId`.
- server emits `identity` after successful auth.
- no cache + online waits for `identity` before opening provider.
- no cache + offline cannot open persistent storage.
- cache + offline opens provider immediately.
- cache + online matching identity keeps provider.
- cache + online mismatch switches namespace and does not sync stale ops.
- client stores server-provided secret and does not generate one by default.
- IndexedDB does not store plaintext docs or operations.
- `local.provider` remains required and no `local: false` path exists.
