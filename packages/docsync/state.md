# DocSyncClient Refactor: Explicit State Machines

This document defines a refactor plan to introduce explicit, intention-revealing state machines into
`DocSyncClient`. The goal is not to remove behavior, but to **make existing intent explicit**, typed,
and safe in a distributed, offline-first system.

This revision clarifies how previously ad-hoc booleans map to proper state machines.

---

## 1. Split client responsibilities into independent state machines

The client must not have a single monolithic state. Split it into independent concerns:

- Socket (network connectivity)
- Local provider (IndexedDB / SQLite readiness)
- Replication (in-flight vs queued sync)
- Documents (per-document lifecycle)

Each state machine answers a different question.

---

## 2. Socket state machine (connectivity)

The socket state represents whether communication with the server is possible.

### Socket states

- connecting: initial state or reconnect attempt in progress
- connected: socket is live and usable
- disconnected: socket was connected and is now offline
- error: unrecoverable socket failure

### Rules

- Socket state answers only: “Can I talk to the server?”
- Socket state does NOT encode whether a request is already in flight
- All transitions come directly from socket.io events

---

## 3. Local provider state machine (persistence readiness)

The local provider state tracks readiness of IndexedDB / SQLite and identity resolution.

### Local states

- uninitialized: provider not ready yet
- ready: provider and identity resolved
- error: unrecoverable local storage failure

### Rules

- Local and socket states are independent
- Local persistence must work even when socket is disconnected
- Socket disconnect must not affect local state

---

## 4. Derived client state (computed, never stored)

Client state is derived from socket + local states.

### Client states

- loading: local provider not ready
- ready: local ready and socket connected
- offline: local ready and socket disconnected
- error: either local or socket entered error state

### Rules

- Client state is pure derivation
- Never mutate client state directly
- Expose via getter or selector

## 6. Causality control (replaces should-broadcast)

The `_shouldBroadcast` flag encodes **origin tracking**, not replication state.

### Correct model

Operations must carry an origin:

- local
- remote

### Rules

- Local-origin operations:

  - broadcast to other tabs
  - persist locally
  - enqueue for replication

- Remote-origin operations:
  - apply to document
  - do NOT re-broadcast
  - do NOT re-persist as new ops

This is metadata, not a state machine and not a boolean toggle.

---

## 7. Document state machine

Each document has its own lifecycle state.

### Document states

- loading: document is being loaded or created
- ready: document is available and bound
- error: document failed to load or deserialize

### Absence handling

- Do NOT cache “missing” documents by default
- If a document is not found and `createIfMissing === false`:
  - return `undefined`
  - do not store any cache entry

This avoids negative caching issues in distributed environments.

---

## 8. Guard behavior using state, not flags

Behavior must be guarded by explicit state machines:

- Replication runs only when socket state is `connected`
- Replication state guarantees no overlapping requests
- Local persistence runs regardless of socket state
- Reconnect triggers replication restart if dirty

No behavior should depend on ad-hoc booleans.

---

## 9. State transition discipline

- Each state machine owns its transitions
- Transitions happen in one place
- Methods react to state; they do not infer it

---

## 10. Invariants to enforce

- No silent constructor mocks
- No implicit state encoded in promises
- No overlapping replication requests
- No permanent negative cache
- No behavior hidden in booleans

---

## 11. Expected outcomes

After this refactor, the sync engine should:

- Preserve all existing behavior intentionally
- Be deterministic and race-free
- Correctly handle offline-first workflows
- Support future server-side sync
- Be easier to reason about, test, and extend

This refactor is structural and intentional. It encodes intent explicitly instead of implicitly.
