# Real-Time Synchronization Test Plan

## Configuration Variables (3)

1. **broadcastChannel**: `true` | `false` - Client config for intra-device sync
2. **realTime**: `true` | `false` - Client config for server dirty events
3. **Same User**: `yes` | `no` - Whether clients share IndexedDB (same userId)

**Total config combinations**: 2^3 = 8

## Runtime States (2)

4. **Client sends ops**: `yes` (push) | `no` (pull-only) - Whether client has local changes to push
5. **Server has ops**: `yes` | `no` (up-to-date) - Whether server has operations client doesn't have

**Total state combinations per config**: 2^2 = 4

**Grand total**: 8 configs × 4 states = 32 scenarios

## Mechanism Matrix

| Mechanism           | Same User        | Different Users        | Requires Server |
| ------------------- | ---------------- | ---------------------- | --------------- |
| BroadcastChannel    | ✅ Works         | ❌ Doesn't cross users | ❌ No           |
| Server Dirty Events | ⚠️ Problematic\* | ✅ Works               | ✅ Yes          |
| Shared IndexedDB    | ✅ Implicit      | ❌ Different DBs       | ❌ No           |

\*Problematic because both clients share the same clock in IndexedDB, so server won't return operations.

## Feasible Scenarios

### A. Same User Scenarios (Shared IndexedDB)

#### A1. BroadcastChannel: ON, RealTime: ON

- **Mechanism**: BroadcastChannel (primary), Server Dirty (secondary)
- **Flow**:
  1. Client1 makes change → saves to IndexedDB → broadcasts via BroadcastChannel
  2. Client2 receives broadcast → applies operations immediately
  3. Client1 pushes to server → dirty event to client2 (redundant)
- **Result**: ✅ **Works perfectly** - Client2 sees change immediately
- **Test**: Config 1

#### A2. BroadcastChannel: ON, RealTime: OFF

- **Mechanism**: BroadcastChannel only
- **Flow**:
  1. Client1 makes change → saves to IndexedDB → broadcasts via BroadcastChannel
  2. Client2 receives broadcast → applies operations immediately
  3. NO dirty event (realTime: false)
- **Result**: ✅ **Works** - Client2 sees change immediately via BroadcastChannel
- **Test**: Config 3

#### A3. BroadcastChannel: OFF, RealTime: ON

- **Mechanism**: Server Dirty Events only
- **Flow**:
  1. Client1 makes change → saves to IndexedDB (clock: 0) → pushes to server
  2. Server saves with clock: 1, updates IndexedDB via consolidation
  3. Client2 shares IndexedDB, so now has clock: 1
  4. Dirty event fires → Client2 pulls with clock: 1
  5. Server says "no ops with clock > 1" → returns empty
  6. Client2's in-memory doc is stale (still doesn't have the change)
- **Result**: ❌ **BROKEN** - Client2 never sees the change in memory
- **Problem**: Shared IndexedDB means shared clock, preventing server from returning ops
- **Test**: Config 2 (currently failing)
- **Status**: 🚫 **NOT SUPPORTED** - Requires architectural changes

#### A4. BroadcastChannel: OFF, RealTime: OFF

- **Mechanism**: None (manual sync only)
- **Flow**:
  1. Client1 makes change → saves to IndexedDB
  2. Client2 has no mechanism to be notified
  3. Client2 would need to manually call `saveRemote()` or reload doc
- **Result**: ✅ **Expected behavior** - No automatic sync
- **Test**: Config 4

### B. Different User Scenarios (Separate IndexedDB)

#### B1. BroadcastChannel: ON, RealTime: ON

- **Mechanism**: Server Dirty Events (BroadcastChannel doesn't cross users)
- **Flow**:
  1. Client1 makes change → saves to IndexedDB1 (clock: 0) → pushes to server
  2. Server saves with clock: 1
  3. Dirty event fires → Client2 pulls with clock: 0 (from IndexedDB2)
  4. Server returns operations (clock: 1 > 0)
  5. Client2 applies operations to in-memory doc
- **Result**: ✅ **Works** - Client2 sees change via server
- **Test**: "realTime=true - server dirty events work across users"
- **Note**: BroadcastChannel config is irrelevant for different users

#### B2. BroadcastChannel: ON, RealTime: OFF

- **Mechanism**: None effective (BroadcastChannel doesn't cross users)
- **Flow**:
  1. Client1 makes change → saves to IndexedDB1
  2. BroadcastChannel doesn't reach Client2 (different user)
  3. No dirty event (realTime: false)
  4. Client2 has no notification mechanism
- **Result**: ✅ **Expected behavior** - No automatic sync across users
- **Test**: "realTime=false - no automatic sync across users"

#### B3. BroadcastChannel: OFF, RealTime: ON

- **Mechanism**: Server Dirty Events
- **Flow**: Same as B1
- **Result**: ✅ **Works** - Server dirty events work correctly
- **Test**: Covered by B1 (broadcastChannel config doesn't matter for different users)

#### B4. BroadcastChannel: OFF, RealTime: OFF

- **Mechanism**: None
- **Flow**: Same as B2
- **Result**: ✅ **Expected behavior** - No automatic sync
- **Test**: Covered by B2

## Valid Test Scenarios (9 total)

### Same User Tests (4)

1. ✅ **Config 1**: BC=ON, RT=ON - Both mechanisms active
2. 🚫 **Config 2**: BC=OFF, RT=ON - **NOT SUPPORTED** (broken by design)
3. ✅ **Config 3**: BC=OFF, RT=ON - Only BroadcastChannel
4. ✅ **Config 4**: BC=OFF, RT=OFF - No automatic sync

### Different User Tests (2)

5. ✅ **Cross-user RT=ON**: Server dirty events work
6. ✅ **Cross-user RT=OFF**: No automatic sync

### Edge Cases (3)

7. ✅ **BroadcastChannel guard**: Sending when BC disabled doesn't throw
8. ✅ **Auto-subscribe RT=ON**: Documents subscribe automatically
9. ✅ **No subscribe RT=OFF**: Documents don't subscribe

## Runtime State Matrix

### All Possible Runtime States

| Client Sends Ops | Server Has Ops | Scenario Description                           | Server Response        | Client Action                  |
| ---------------- | -------------- | ---------------------------------------------- | ---------------------- | ------------------------------ |
| ❌ No (pull)     | ❌ No          | Client checks for updates, none available      | Empty ops, same clock  | No-op                          |
| ❌ No (pull)     | ✅ Yes         | Client pulls new operations                    | Returns ops, new clock | Apply ops to doc               |
| ✅ Yes (push)    | ❌ No          | Client pushes changes, server has nothing new  | Empty ops, new clock   | Consolidate local ops          |
| ✅ Yes (push)    | ✅ Yes         | Client pushes changes, server also has new ops | Returns ops, new clock | Apply server ops + consolidate |

### Common Scenarios Explained

#### Scenario 1: Pull-only, Up-to-date

**State**: Client sends 0 ops, Server has 0 ops

```
Client → Server: { clock: 5, operations: [] }
Server → Client: { clock: 5, operations: [] }
```

**Result**: No changes needed

#### Scenario 2: Pull-only, Behind

**State**: Client sends 0 ops, Server has ops

```
Client → Server: { clock: 3, operations: [] }
Server → Client: { clock: 5, operations: [op4, op5] }
```

**Result**: Client applies op4 and op5

#### Scenario 3: Push-only, Server up-to-date

**State**: Client sends ops, Server has 0 ops

```
Client → Server: { clock: 5, operations: [clientOp] }
Server → Client: { clock: 6, operations: [] }
```

**Result**: Client consolidates local op into serialized doc

#### Scenario 4: Push-Pull, Both have changes

**State**: Client sends ops, Server has ops

```
Client → Server: { clock: 3, operations: [clientOp] }
Server → Client: { clock: 5, operations: [serverOp4, serverOp5] }
```

**Result**: Client applies server ops first, then consolidates local op

## Server Operation Response Scenarios

When client syncs with server:

| Scenario          | Client Clock | Server Has Ops  | Server Response | Client Action  |
| ----------------- | ------------ | --------------- | --------------- | -------------- |
| Fresh pull        | 0            | Yes (clock: 1+) | Returns ops     | Apply to doc   |
| Up to date        | 5            | No (clock: 5)   | Empty ops       | No-op          |
| Behind            | 3            | Yes (clock: 5)  | Returns ops 4,5 | Apply to doc   |
| Same user, synced | 5            | Yes (clock: 5)  | Empty ops       | 🚫 **PROBLEM** |

**The "Same user, synced" problem:**

- Client1 pushes ops → Server stores with clock: 5 → Updates IndexedDB
- Client2 shares IndexedDB → Also has clock: 5 now
- Dirty event → Client2 pulls with clock: 5
- Server: "No ops with clock > 5" → Returns empty
- Client2's in-memory doc never updates ❌

## Solutions for Config 2 (Same User, No BC, RealTime ON)

### Option 1: Don't Support This Config ✅ RECOMMENDED

- Mark as `.todo()` or `.skip()`
- Document in README that same-user realTime requires BroadcastChannel
- This is a reasonable limitation

### Option 2: Storage Events API

- Listen to `storage` events (only works for `localStorage`, not IndexedDB)
- Would require refactoring storage layer
- Limited browser support for IndexedDB storage events

### Option 3: Polling IndexedDB

- Periodically check IndexedDB for changes
- Performance overhead
- Not true "real-time"

### Option 4: Server Tracks "Dirty" State Per User

- Server keeps separate clocks for each client session
- Much more complex server logic
- Still doesn't solve the in-memory update problem

### Option 5: Force Full Reload on Dirty

- When dirty event fires and server returns empty ops
- Reload entire document from IndexedDB
- Loses in-memory references (breaks existing doc instances)

## Recommendations

1. **Mark Config 2 as NOT SUPPORTED** ✅
   - Add `.skip()` to the test with explanation
   - Document in README: "Same-user real-time sync requires `broadcastChannel: true`"
2. **Keep Current Tests** (5 passing + 3 skipped = 8)

   - Config 1: ✅ Same user, both mechanisms
   - Config 2: ⏭️ **SKIP** (not supported)
   - Config 3: ✅ Same user, only BC
   - Config 4: ✅ Same user, no sync
   - Cross-user RT=ON: ✅ Server dirty works
   - Cross-user RT=OFF: ✅ No sync
   - BC guard: ✅ No errors
   - Auto-subscribe: ✅ Works with RT=ON
   - No subscribe: ✅ Works with RT=OFF

3. **Future Enhancement**
   - Consider WebLocks API for cross-tab coordination
   - Or SharedWorker for same-origin synchronization
   - These would enable Config 2 support

## Config Validity Table

| BC  | RT  | Same User | Valid? | Sync Method | Status     |
| --- | --- | --------- | ------ | ----------- | ---------- |
| ✅  | ✅  | ✅        | ✅     | BC + Dirty  | Working    |
| ✅  | ✅  | ❌        | ✅     | Dirty only  | Working    |
| ✅  | ❌  | ✅        | ✅     | BC only     | Working    |
| ✅  | ❌  | ❌        | ✅     | None        | Working    |
| ❌  | ✅  | ✅        | 🚫     | Dirty only  | **BROKEN** |
| ❌  | ✅  | ❌        | ✅     | Dirty only  | Working    |
| ❌  | ❌  | ✅        | ✅     | None        | Working    |
| ❌  | ❌  | ❌        | ✅     | None        | Working    |

**Key Insight**: The only broken config is `BC=OFF, RT=ON, Same User` because:

- BroadcastChannel is disabled (can't notify client2)
- Server dirty events don't work (shared clock problem)
- No viable sync mechanism remains

## Complete Scenario Matrix (32 Total)

### Legend

- ✅ Works correctly
- 🚫 Broken by design
- ⚠️ Edge case (works but unusual)
- 💤 No-op (expected behavior)

### Config 1: Same User + BC=ON + RT=ON

| Client Ops | Server Ops | Result | Behavior                                                   |
| ---------- | ---------- | ------ | ---------------------------------------------------------- |
| No         | No         | ✅     | Client2 pulls, nothing changes                             |
| No         | Yes        | ✅     | Client2 pulls ops, applies via BroadcastChannel            |
| Yes        | No         | ✅     | Client1 pushes, Client2 gets via BroadcastChannel + dirty  |
| Yes        | Yes        | ✅     | Client1 pushes, Client2 gets server ops + local ops via BC |

### Config 2: Same User + BC=OFF + RT=ON 🚫 BROKEN

| Client Ops | Server Ops | Result | Behavior                                                                              |
| ---------- | ---------- | ------ | ------------------------------------------------------------------------------------- |
| No         | No         | 💤     | Nothing happens (no changes)                                                          |
| No         | Yes        | ⚠️     | Dirty event fires but client has wrong clock                                          |
| Yes        | No         | 🚫     | **BROKEN**: Client1 pushes, Client2 dirty fires but server returns empty (same clock) |
| Yes        | Yes        | 🚫     | **BROKEN**: Same as above, client2 never sees client1's changes                       |

**Why broken**: Shared IndexedDB means both clients have same clock after client1 pushes, so server won't return ops to client2.

### Config 3: Same User + BC=ON + RT=OFF

| Client Ops | Server Ops | Result | Behavior                                                               |
| ---------- | ---------- | ------ | ---------------------------------------------------------------------- |
| No         | No         | 💤     | Nothing happens                                                        |
| No         | Yes        | 💤     | Server has ops but no dirty event, no pull                             |
| Yes        | No         | ✅     | Client1 pushes, Client2 gets via BroadcastChannel only                 |
| Yes        | Yes        | ✅     | Client1 pushes, Client2 gets via BroadcastChannel (server ops ignored) |

### Config 4: Same User + BC=OFF + RT=OFF

| Client Ops | Server Ops | Result | Behavior                                     |
| ---------- | ---------- | ------ | -------------------------------------------- |
| No         | No         | 💤     | Nothing happens (manual sync only)           |
| No         | Yes        | 💤     | Server has ops but no notification mechanism |
| Yes        | No         | 💤     | Client1 pushes, Client2 has no notification  |
| Yes        | Yes        | 💤     | No automatic sync (expected)                 |

### Config 5: Different Users + BC=ON + RT=ON

| Client Ops | Server Ops | Result | Behavior                                                          |
| ---------- | ---------- | ------ | ----------------------------------------------------------------- |
| No         | No         | 💤     | Nothing happens                                                   |
| No         | Yes        | ✅     | Client2 pulls ops via dirty event                                 |
| Yes        | No         | ✅     | Client1 pushes, dirty fires, Client2 pulls (gets client1's ops)   |
| Yes        | Yes        | ✅     | Client1 pushes, Client2 gets server ops + client1's ops via dirty |

**Note**: BroadcastChannel config is irrelevant (doesn't cross users)

### Config 6: Different Users + BC=OFF + RT=ON

| Client Ops | Server Ops | Result | Behavior                                                 |
| ---------- | ---------- | ------ | -------------------------------------------------------- |
| No         | No         | 💤     | Nothing happens                                          |
| No         | Yes        | ✅     | Client2 pulls ops via dirty event                        |
| Yes        | No         | ✅     | Client1 pushes, dirty fires, Client2 pulls               |
| Yes        | Yes        | ✅     | Same as Config 5 (BC doesn't matter for different users) |

### Config 7: Different Users + BC=ON + RT=OFF

| Client Ops | Server Ops | Result | Behavior                                |
| ---------- | ---------- | ------ | --------------------------------------- |
| No         | No         | 💤     | Nothing happens                         |
| No         | Yes        | 💤     | Server has ops but no dirty event       |
| Yes        | No         | 💤     | Client1 pushes but Client2 not notified |
| Yes        | Yes        | 💤     | No automatic sync across users          |

### Config 8: Different Users + BC=OFF + RT=OFF

| Client Ops | Server Ops | Result | Behavior                           |
| ---------- | ---------- | ------ | ---------------------------------- |
| No         | No         | 💤     | Nothing happens                    |
| No         | Yes        | 💤     | Server has ops but no notification |
| Yes        | No         | 💤     | No automatic sync                  |
| Yes        | Yes        | 💤     | No automatic sync (expected)       |

## Summary Statistics

- **Total scenarios**: 32
- **Working correctly**: 23 ✅
- **Broken by design**: 2 🚫 (Config 2 with client ops)
- **No-op (expected)**: 7 💤

**Only broken scenarios**:

1. Same User + BC=OFF + RT=ON + Client1 sends ops + Server has no ops
2. Same User + BC=OFF + RT=ON + Client1 sends ops + Server has ops

Both fail for the same reason: shared clock problem.
