# DocSync Test Modes - Behavior Differences Analysis

This document analyzes the concrete behavioral differences between the three DocSync modes to inform test architecture decisions.

## Configuration Differences

```typescript
// local-only
new DocSyncClient({
  docBinding,
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({ userId, secret }),
  },
});

// local-first
new DocSyncClient({
  docBinding,
  server: {
    url: "ws://localhost:8082",
    auth: { getToken: async () => token },
  },
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({ userId, secret }),
  },
});

// server-only
new DocSyncClient({
  docBinding,
  server: {
    url: "ws://localhost:8082",
    auth: { getToken: async () => token },
  },
  // NO local config - uses RemoteProvider internally
});
```

---

## Behavioral Differences by Scenario

### 1. Document Creation

**local-only:**

- ✅ Document created immediately in IndexedDB
- ✅ Available in same tab instantly
- ✅ Available in other tabs for SAME userId (shared IndexedDB)
- ❌ NOT available for different userId (separate IndexedDB databases)
- ✅ Survives page reload
- ✅ Works offline

**local-first:**

- ✅ Document created immediately in IndexedDB
- ✅ Available in same tab instantly
- ✅ Available in other tabs for SAME userId (shared IndexedDB)
- ✅ Syncs to server automatically
- ⏱️ Available to OTHER userIds after sync completes (~200ms)
- ✅ Survives page reload
- ✅ Works offline (syncs when online)

**server-only:**

- ⏱️ Document created on server (network roundtrip)
- ❌ NOT available after page reload (no local persistence)
- ✅ Available to OTHER userIds immediately (shared server)
- ❌ Does NOT work offline

---

### 2. Same User, Multiple Tabs (Shared IndexedDB)

**Scenario:** User opens doc in Tab 1, makes edit, opens Tab 2

**local-only:**

```typescript
// Tab 1
const doc1 = await getDoc(client1, { type: "test", createIfMissing: true });
doc1.root.append(child);
// Saved to IndexedDB

// Tab 2 (same userId)
const doc2 = await getDoc(client2, { type: "test", id: doc1.id });
// ✅ SEES the child (reads from shared IndexedDB)

// Tab 1 makes another edit
doc1.root.append(child2);
// Tab 2 does NOT see child2 automatically (no BroadcastChannel yet?)
```

**local-first:**

```typescript
// Same as local-only PLUS:
// - Changes also go to server
// - Other users can see changes
```

**server-only:**

```typescript
// Tab 1
const doc1 = await getDoc(client1, { type: "test", createIfMissing: true });
// Saved to server

// Tab 2 (same userId)
const doc2 = await getDoc(client2, { type: "test", id: doc1.id });
// ✅ SEES the doc (fetches from server)
// ❌ But if Tab 1 is closed and page reloads, doc is LOST (no local persistence)
```

---

### 3. Different Users, Same Device

**Scenario:** User A creates doc, User B tries to access

**local-only:**

```typescript
// User A (userId: "alice")
const docA = await getDoc(clientA, { type: "test", createIfMissing: true });
// Saved to IndexedDB database: "docsync-alice"

// User B (userId: "bob")
const docB = await getDoc(clientB, { type: "test", id: docA.id });
// ❌ CANNOT access - looks in "docsync-bob" database
// Result: undefined
```

**local-first:**

```typescript
// User A
const docA = await getDoc(clientA, { type: "test", createIfMissing: true });
// Saved to IndexedDB "docsync-alice" AND server

// User B
const docB = await getDoc(clientB, { type: "test", id: docA.id });
// ✅ CAN access (fetches from server)
// ⚠️ But requires authorization check on server
```

**server-only:**

```typescript
// Same as local-first (both fetch from server)
// No IndexedDB isolation - all data on server
```

---

### 4. Offline → Online Transition

**local-only:**

```typescript
// Go offline (disconnect network)
const doc = await getDoc(client, { type: "test", createIfMissing: true });
doc.root.append(child);
// ✅ Works perfectly - no network needed

// Go online
// Nothing happens - no server to sync to
```

**local-first:**

```typescript
// Go offline
const doc = await getDoc(client, { type: "test", createIfMissing: true });
doc.root.append(child);
// ✅ Works - saved to IndexedDB

// Go online
// ✅ Automatically syncs to server
// ✅ Other users can now see the doc
```

**server-only:**

```typescript
// Go offline
const doc = await getDoc(client, { type: "test", createIfMissing: true });
// ❌ FAILS - cannot reach server
// ❌ Cannot work offline at all
```

---

### 5. Page Reload / Session Persistence

**local-only:**

```typescript
// Session 1
const doc1 = await getDoc(client1, { type: "test", createIfMissing: true });
doc1.root.append(child);

// [Page reload]

// Session 2 (same userId)
const doc2 = await getDoc(client2, { type: "test", id: doc1.id });
// ✅ SEES the doc with child (persisted in IndexedDB)
```

**local-first:**

```typescript
// Same as local-only
// ✅ Persists locally AND on server
```

**server-only:**

```typescript
// Session 1
const doc1 = await getDoc(client1, { type: "test", createIfMissing: true });
doc1.root.append(child);
// Saved to server (InMemoryServerProvider in tests)

// [Page reload - client refreshes, server KEEPS RUNNING]

// Session 2 (same userId)
const doc2 = await getDoc(client2, { type: "test", id: doc1.id });
// ✅ SEES the doc with child (fetched from server)
// Server is in globalSetup, survives client reload
```

**Important:** In tests, the server runs in `globalSetup` (separate process), so it persists across client page reloads. The InMemoryServerProvider keeps data during the entire test run.

---

### 6. Multiple Browser Tabs / Contexts

**Vitest Browser Mode Limitations:**
Vitest browser mode uses Playwright/WebDriver under the hood, but exposes a simplified API. Currently (as of Vitest 4.0.8):

- ❌ No direct access to `page.context().newPage()`
- ❌ No `browser.newPage()` or multiple contexts API
- ✅ Each test runs in a single browser context/page
- ✅ Can simulate "multiple tabs" by creating multiple `DocSyncClient` instances in the SAME test
  - They share IndexedDB (same origin) ✅
  - They DON'T share in-memory state (separate object instances) ✅
  - They **DO** share BroadcastChannel (same origin) ✅

**Current approach (works well):**

```typescript
// "Simulates" two tabs by having two client instances
const { client: client1 } = createClient(sharedUserId);
const { client: client2 } = createClient(sharedUserId);

// client1 makes a change
doc1.root.append(child);
// → Broadcasts via BroadcastChannel("docsync")

// client2 receives the message immediately
// → Applies operations automatically via onmessage handler
```

**Why this works:**

- BroadcastChannel works **within a browsing context** (same origin)
- Doesn't require separate tabs/windows
- Multiple instances can communicate in the same script
- This is actually **ideal for testing** - deterministic, no race conditions

**What we CAN'T test easily:**

- True tab isolation (separate JS global scopes)
- Service Workers across separate contexts
- True parallel execution in different event loops

**Alternative for true multi-tab:**
Use Playwright E2E tests (`.e2e.test.ts`) which have full Playwright API:

```typescript
const context1 = await browser.newContext();
const page1 = await context1.newPage();

const context2 = await browser.newContext();
const page2 = await context2.newPage();
```

---

### 6. Concurrent Edits (Same Doc, Different Clients)

**local-only:**

```typescript
// Client 1 (Alice)
const doc1 = await getDoc(client1, { type: "test", id: "doc-123" });
doc1.root.append(childA);

// Client 2 (Bob, different userId)
const doc2 = await getDoc(client2, { type: "test", id: "doc-123" });
// ❌ CANNOT access - different IndexedDB

// Client 2 (Alice, same userId in another tab)
const doc2 = await getDoc(client2Same, { type: "test", id: "doc-123" });
doc2.root.append(childB);
// ⚠️ CONFLICT - both clients have separate in-memory docs
// ⚠️ Last write to IndexedDB wins - childA OR childB lost!
```

**local-first:**

```typescript
// Client 1 (Alice)
const doc1 = await getDoc(client1, { type: "test", id: "doc-123" });
doc1.root.append(childA);
// Syncs to server

// Client 2 (Bob)
const doc2 = await getDoc(client2, { type: "test", id: "doc-123" });
// Fetches from server, sees childA
doc2.root.append(childB);
// Syncs to server

// Server merges operations with CRDT rules
// ✅ Both childA and childB preserved
```

**server-only:**

```typescript
// Same as local-first (all via server)
```

---

### 7. Authorization

**local-only:**

```typescript
// NO authorization - local-only is single-device
// IndexedDB namespace separation is NOT security
// Any code can access any IndexedDB database
```

**local-first & server-only:**

```typescript
// Server enforces authorization
authenticate: async ({ token }) => {
  const userId = validateToken(token);
  return { userId };
},

authorize: async ({ type, payload, userId }) => {
  if (type === "get-doc") {
    return await canUserAccessDoc(userId, payload.docId);
  }
  // ...
}
```

---

## Key Insights for Test Architecture

### What's Actually Different?

1. **Persistence location**

   - local-only: IndexedDB only
   - local-first: IndexedDB + Server
   - server-only: Server only (currently in-memory, breaks on reload!)

2. **Cross-user access**

   - local-only: Impossible (separate IndexedDB)
   - local-first: Possible (via server)
   - server-only: Possible (via server)

3. **Offline capability**

   - local-only: Full
   - local-first: Full (syncs when online)
   - server-only: None

4. **Conflict resolution**
   - local-only: Last write wins (breaks!)
   - local-first: CRDT merge on server
   - server-only: CRDT merge on server

### What's the Same?

1. Document API (`getDoc`, create, read, update)
2. Node operations (append, delete, move)
3. Type system and DocBinding
4. In-memory document representation
5. Same-user, same-tab behavior

### Recommendations

**DON'T abstract:**

- Setup/configuration (too different)
- Cross-user tests (doesn't apply to local-only)
- Offline tests (doesn't apply to server-only)
- Authorization tests (doesn't apply to local-only)

**DO abstract/share:**

- Basic CRUD operations (same API)
- Single-client node operations
- Serialization/deserialization
- Error handling for invalid inputs
- Document lifecycle (create, unload, cleanup)

**Separate test suites:**

- `shared/basic-operations.test.ts` - CRUD, works everywhere
- `local-only/indexeddb-isolation.test.ts` - Multi-user on same device
- `local-first/sync.test.ts` - Cross-device, cross-user sync
- `local-first/offline.test.ts` - Offline → online transition
- `server-only/remote.test.ts` - Pure server operations (once RemoteProvider works)

### Critical Missing Piece

**Vitest Browser Limitations:**

- Multiple client instances in one test ≠ true multiple tabs
- No access to Playwright's multi-context API
- For true tab isolation, need Playwright E2E tests

**server-only persistence:**

- ✅ Works in tests (globalSetup keeps server alive)
- ⚠️ InMemoryServerProvider is only for tests
- ⚠️ Production needs PostgresProvider or similar
- ❌ RemoteProvider not yet implemented (client-side server-only storage)

---

## Proposed Test Organization

```
tests/docsync/
  ├── shared/
  │   ├── basic-operations.test.ts      # Import in all 3 modes
  │   ├── document-lifecycle.test.ts    # Import in all 3 modes
  │   └── utils.ts                      # Shared helpers
  │
  ├── local-only/
  │   ├── index.browser.test.ts         # Basic ops + local-only specific
  │   ├── multi-user-isolation.test.ts  # Different userIds on same device
  │   └── persistence.test.ts           # Reload, IndexedDB
  │
  ├── local-first/
  │   ├── index.browser.test.ts         # Basic ops + sync specific
  │   ├── sync.test.ts                  # Cross-user, cross-device
  │   ├── offline.test.ts               # Offline/online transitions
  │   ├── conflicts.test.ts             # Concurrent edits
  │   ├── authorization.test.ts         # Server-enforced auth
  │   └── globalSetup.ts
  │
  └── server-only/
      ├── index.browser.test.ts         # When RemoteProvider exists
      ├── authorization.test.ts         # Same as local-first
      └── globalSetup.ts
```

**Key principle:** Share tests only when behavior is IDENTICAL, not similar.
