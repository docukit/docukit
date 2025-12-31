# Real-Time Synchronization Test Plan

## Overview

This document defines the comprehensive test strategy for real-time synchronization in docsync. We test **all 32 possible combinations** of configurations and runtime states to verify correct behavior or expected failures.

## Test Space: 32 Total Scenarios

### Configuration Variables (8 combinations)

| #   | BC  | RT  | Same User | Label                             |
| --- | --- | --- | --------- | --------------------------------- |
| 1   | ✅  | ✅  | ✅        | Same user + Both mechanisms       |
| 2   | ✅  | ✅  | ❌        | Different users + Both mechanisms |
| 3   | ✅  | ❌  | ✅        | Same user + BC only               |
| 4   | ✅  | ❌  | ❌        | Different users + BC only         |
| 5   | ❌  | ✅  | ✅        | Same user + RT only (BROKEN)      |
| 6   | ❌  | ✅  | ❌        | Different users + RT only         |
| 7   | ❌  | ❌  | ✅        | Same user + No sync               |
| 8   | ❌  | ❌  | ❌        | Different users + No sync         |

### Runtime States (4 per configuration)

| #   | Client Sends Ops        | Server Has Ops         | Scenario                                 |
| --- | ----------------------- | ---------------------- | ---------------------------------------- |
| A   | ❌ No (sync with 0 ops) | ❌ No (responds 0 ops) | Up-to-date check - sync event with 0 ops |
| B   | ❌ No (pull/0 ops)      | ✅ Yes (responds ops)  | Pull new operations - client syncs 0 ops |
| C   | ✅ Yes (push with ops)  | ❌ No (responds 0 ops) | Push-only - server responds 0 ops        |
| D   | ✅ Yes (push with ops)  | ✅ Yes (responds ops)  | Bidirectional sync - both sides have ops |

**Key Concept**: "No ops" means a sync happens but with 0 operations. It's NOT the absence of sync.

**Total: 8 configs × 4 states = 32 test scenarios**

---

## Sync Mechanisms Explained

### 1. BroadcastChannel (Browser API)

- **Scope**: Same user, same device, same browser origin
- **Mechanism**: In-process communication between tabs
- **Speed**: Instant
- **Limitation**: Cannot cross users or devices

### 2. Server Dirty Events (WebSocket)

- **Scope**: Any users, any devices
- **Mechanism**: Server notifies subscribed clients
- **Speed**: Network latency (~10-50ms)
- **Limitation**: Requires server + has "shared clock problem" for same-user configs

### 3. Shared IndexedDB (Implicit)

- **Scope**: Same user only (keyed by `userId`)
- **Mechanism**: Direct read from shared storage
- **Effect**: Persistence only, not in-memory updates

---

## The 32 Test Scenarios

### Legend

- ✅ Works correctly
- 🚫 Broken (negative test)
- 💤 No-op (expected)
- ⚠️ Edge case

---

## Config 1: Same User + BC=ON + RT=ON (Both mechanisms)

**Sync mechanism**: BroadcastChannel (primary) + Server Dirty (secondary)

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                     | Test Type   |
| --- | -------------------- | ------------------ | ----------------------------------------------------- | ----------- |
| 1A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0 ops, server responds 0, BC event w/ 0 | ✅ Positive |
| 1B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, gets server ops via dirty event      | ✅ Positive |
| 1C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 gets via BC instantly     | ✅ Positive |
| 1D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Client1 pushes ops, Client2 gets both via BC + dirty  | ✅ Positive |

---

## Config 2: Different Users + BC=ON + RT=ON (Both mechanisms, but BC ineffective)

**Sync mechanism**: Server Dirty only (BC doesn't cross users)

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                        | Test Type   |
| --- | -------------------- | ------------------ | -------------------------------------------------------- | ----------- |
| 2A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, no dirty event       | 💤 No-op    |
| 2B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, gets server ops via dirty event         | ✅ Positive |
| 2C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 gets via dirty event         | ✅ Positive |
| 2D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Client1 pushes ops, Client2 gets all ops via dirty event | ✅ Positive |

---

## Config 3: Same User + BC=ON + RT=OFF (BC only)

**Sync mechanism**: BroadcastChannel only

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                                        | Test Type   |
| --- | -------------------- | ------------------ | ------------------------------------------------------------------------ | ----------- |
| 3A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, BC event w/ 0                        | 💤 No-op    |
| 3B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, server has ops but no dirty event, Client2 doesn't see  | 💤 No-op    |
| 3C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 gets via BC instantly                        | ✅ Positive |
| 3D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Client1 pushes ops, Client2 gets client1 ops via BC (server ops ignored) | ✅ Positive |

---

## Config 4: Different Users + BC=ON + RT=OFF (No effective mechanism)

**Sync mechanism**: None (BC doesn't work, RT disabled)

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                            | Test Type |
| --- | -------------------- | ------------------ | ------------------------------------------------------------ | --------- |
| 4A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, no realtime notification | 💤 No-op  |
| 4B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, server has ops but Client2 doesn't see      | 💤 No-op  |
| 4C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 doesn't see (no sync mechanism)  | 💤 No-op  |
| 4D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Both have ops but no automatic sync mechanism                | 💤 No-op  |

**Enhancement**: Add manual sync test - after 4D, call `onLocalOperations()` and verify Client2 then sees changes.

---

## Config 5: Same User + BC=OFF + RT=ON (BROKEN CONFIG)

**Sync mechanism**: Server Dirty only (broken by shared clock problem)

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                                 | Test Type   |
| --- | -------------------- | ------------------ | ----------------------------------------------------------------- | ----------- |
| 5A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, no dirty needed               | 💤 No-op    |
| 5B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, dirty fires but shared clock causes empty result | 🚫 Negative |
| 5C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, dirty fires but Client2 has same clock        | 🚫 Negative |
| 5D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Same as 5C - Client2 never sees client1's changes                 | 🚫 Negative |

**All scenarios 5B-5D must verify**:

1. ❌ Client2 in-memory doc doesn't update
2. ❌ BroadcastChannel is not used (it's disabled)
3. ✅ After reload, Client2 sees changes (IndexedDB has them)

---

## Config 6: Different Users + BC=OFF + RT=ON (Server Dirty only)

**Sync mechanism**: Server Dirty Events

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                         | Test Type   |
| --- | -------------------- | ------------------ | --------------------------------------------------------- | ----------- |
| 6A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, no dirty event needed | 💤 No-op    |
| 6B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, pulls ops via dirty event                | ✅ Positive |
| 6C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 gets via dirty event          | ✅ Positive |
| 6D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Client1 pushes ops, Client2 gets all ops via dirty event  | ✅ Positive |

---

## Config 7: Same User + BC=OFF + RT=OFF (No automatic sync)

**Sync mechanism**: None (manual sync only)

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                          | Test Type |
| --- | -------------------- | ------------------ | ---------------------------------------------------------- | --------- |
| 7A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, no automatic mechanism | 💤 No-op  |
| 7B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, server has ops but Client2 doesn't see    | 💤 No-op  |
| 7C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 doesn't see (no sync)          | 💤 No-op  |
| 7D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Both have ops but no automatic sync                        | 💤 No-op  |

**Enhancement**: For 7C and 7D, add reload verification:

1. ❌ Verify Client2 in-memory doc is out of sync
2. Unload Client2's doc
3. Reload from IndexedDB
4. ✅ Verify Client2 now sees changes

---

## Config 8: Different Users + BC=OFF + RT=OFF (No automatic sync)

**Sync mechanism**: None (manual sync only)

| #   | Client Ops (Client1) | Server Ops         | Expected Behavior                                   | Test Type |
| --- | -------------------- | ------------------ | --------------------------------------------------- | --------- |
| 8A  | ❌ No (sync w/ 0)    | ❌ No (0 response) | Client1 syncs 0, server responds 0, no notification | 💤 No-op  |
| 8B  | ❌ No (sync w/ 0)    | ✅ Yes (has ops)   | Client2 syncs 0, server has ops but no notification | 💤 No-op  |
| 8C  | ✅ Yes (push ops)    | ❌ No (0 response) | Client1 pushes ops, Client2 doesn't see             | 💤 No-op  |
| 8D  | ✅ Yes (push ops)    | ✅ Yes (has ops)   | Both have ops but no automatic sync                 | 💤 No-op  |

**Enhancement**: For 8D, add manual sync test:

1. ❌ Verify Client2 doesn't see changes
2. Call `client2.onLocalOperations({ docId, operations: [] })`
3. ✅ Verify Client2 now sees changes

---

## Test Summary Matrix

### By Config

| Config    | Valid?    | Positive Tests | Negative Tests | No-op Tests | Total  |
| --------- | --------- | -------------- | -------------- | ----------- | ------ |
| 1         | ✅ Yes    | 4              | 0              | 0           | 4      |
| 2         | ✅ Yes    | 3              | 0              | 1           | 4      |
| 3         | ✅ Yes    | 2              | 0              | 2           | 4      |
| 4         | ✅ Yes    | 0              | 0              | 4           | 4      |
| 5         | 🚫 Broken | 0              | 3              | 1           | 4      |
| 6         | ✅ Yes    | 3              | 0              | 1           | 4      |
| 7         | ✅ Yes    | 0              | 0              | 4           | 4      |
| 8         | ✅ Yes    | 0              | 0              | 4           | 4      |
| **Total** |           | **12**         | **3**          | **17**      | **32** |

### By Test Type

- ✅ **Positive tests** (12): Verify sync works as expected
- 🚫 **Negative tests** (3): Verify broken config fails predictably
- 💤 **No-op tests** (17): Verify no sync happens when expected

---

## Implementation Roadmap

### Phase 1: Core Configs (Currently Implemented)

- [x] Config 1 - Test 1C (Same user + both mechanisms + client pushes)
- [x] Config 3 - Test 3C (Same user + BC only + client pushes)
- [x] Config 6 - Test 6C (Different users + RT only + client pushes)
- [x] Config 7 - Test 7C (Same user + no sync + verify no sync)
- [x] Config 8 - Test 8C (Different users + no sync + verify no sync)

**Current coverage: 5 tests** (focusing on 1C scenarios)

### Phase 2: Expand Runtime States

Add tests for A, B, and D scenarios for each config:

- [ ] 1A, 1B, 1D (Config 1 - all states)
- [ ] 2A, 2B, 2C, 2D (Config 2 - all states)
- [ ] 3A, 3B, 3D (Config 3 - remaining states)
- [ ] 4A, 4B, 4C, 4D (Config 4 - all states)
- [ ] 6A, 6B, 6D (Config 6 - remaining states)
- [ ] 7A, 7B, 7D (Config 7 - remaining states)
- [ ] 8A, 8B, 8D (Config 8 - remaining states)

**Target: 27 additional tests → 32 total**

### Phase 3: Negative Tests for Config 5

- [ ] 5B - Server has ops, dirty fires, empty response
- [ ] 5C - Client pushes, dirty fires, empty response
- [ ] 5D - Both have ops, dirty fires, empty response

All three must verify:

1. In-memory doc doesn't sync
2. BC not used (it's disabled)
3. Reload from IndexedDB works

**Target: 3 negative tests**

### Phase 4: Enhanced Verifications

- [ ] Config 4D: Add manual sync after no-op
- [ ] Config 7C/7D: Add reload verification
- [ ] Config 8D: Add manual sync verification

---

## Technical Details

### Runtime State Setup

#### State A: No ops either side (sync with 0 ops)

```typescript
// Client1 creates doc, waits for initial sync to complete
// Client2 loads doc, waits for sync to complete
// Neither makes changes after sync
// Client1 (or Client2) triggers sync with 0 operations
// Verify: Sync event happens with 0 ops, appropriate realtime notification
```

#### State B: Server has ops, client sends 0

```typescript
// Client1 creates doc, syncs
// Client2 loads doc, syncs
// External change happens on server (simulate via Client3)
// Client2 triggers sync with 0 ops (pull)
// Verify: Client2 receives server ops via appropriate mechanism
```

#### State C: Client sends ops, server responds 0

```typescript
// Client1 creates doc, syncs
// Client2 loads doc, syncs
// Client1 makes change (generates ops)
// Client1 triggers sync, pushing those ops
// Server has no new ops, responds with 0
// Verify: Client2 receives change via appropriate mechanism
```

#### State D: Both have ops

```typescript
// Client1 creates doc, syncs
// Client2 loads doc, syncs
// External change on server (via Client3)
// Client1 makes change concurrently (generates ops)
// Client1 triggers sync, pushing ops
// Server responds with its ops
// Verify: Client2 receives both client1's and server's ops
```

### The Shared Clock Problem (Config 5)

**Why Config 5 is broken:**

```
Initial state:
  Client1 IndexedDB: { docId, clock: 5 }
  Client2 IndexedDB: { docId, clock: 5 } // SHARED!
  Server: { docId, clock: 5 }

Client1 makes change:
  1. Client1 pushes operations to server
  2. Server increments clock to 6, saves operations
  3. Server consolidates, saves to IndexedDB
  4. Now IndexedDB has: { docId, clock: 6 }

Dirty event fires:
  5. Client2 receives dirty notification
  6. Client2 reads IndexedDB: clock = 6 // Already updated!
  7. Client2 pulls from server with clock: 6
  8. Server: "SELECT * WHERE clock > 6" → empty results
  9. Client2's in-memory doc never updates ❌
```

**Solution**: Config 5 requires BroadcastChannel. Use Config 1 instead.

### Reload vs Manual Sync

**Reload** (unload + getDoc):

- Loads entire document from IndexedDB
- Applies any pending operations
- Use for: Same-user no-sync scenarios (Config 7)

**Manual Sync** (onLocalOperations with empty ops):

- Triggers server pull/push
- Gets operations from server
- Use for: Different-user no-sync scenarios (Config 8)

---

## Quick Reference

### When to Use Each Config

```
Need real-time sync between same-user tabs?
  → Config 1 (BC + RT) - Best, redundant mechanisms

Need real-time sync across different users?
  → Config 2 (BC + RT) or Config 6 (RT only) - BC is harmless but unused

Want offline-first, same-user only?
  → Config 3 (BC only) - Works offline

Manual sync only, same user?
  → Config 7 (No auto-sync) - Use reload pattern

Manual sync only, different users?
  → Config 8 (No auto-sync) - Use manual sync API

DON'T USE: Config 5 (Same user + RT only) - Broken by design
```

### Decision Tree

```
Same user tabs?
├─ Yes → Need real-time?
│         ├─ Yes → Config 1 (BC + RT)
│         └─ No → Config 7 (Manual)
│
└─ No → Need real-time?
          ├─ Yes → Config 6 (RT only)
          └─ No → Config 8 (Manual)
```

---

## Appendix: Future Enhancements

### Option A: Fix Config 5

- Implement per-client-session clocks on server
- Use WebLocks API for tab coordination
- Requires architectural changes

### Option B: Simplify to 3 Recommended Configs

- Config 1: Same user + real-time
- Config 6: Different users + real-time
- Config 7/8: Manual sync
- Mark others as "not recommended"

### Option C: Add Explicit "Mode" Setting

```typescript
mode: "same-user" | "multi-user" | "manual";
// Automatically sets BC + RT appropriately
```
