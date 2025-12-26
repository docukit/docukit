# DocSync: Sync Model

This document explains how DocSync synchronizes documents between clients and a central server.

## Overview

DocSync uses a **central server model** where:

- Clients generate operations locally
- The server is the single source of truth for operation ordering
- Documents are stored in a serialized form with lazy operation application

## Core Concepts

### Clock

A **clock** represents a version/point-in-time in the document's history.

- The **server is the only authority** that assigns clocks
- Operations stored on the server have a clock
- Local (unsent) operations do NOT have a clock
- The clock can be implemented as:
  - An auto-incrementing integer
  - A timestamp (recommended: doubles as `updatedAt`)

### Why Lazy Operation Application?

The server could apply every incoming operation immediately:

```
receive operations → load doc → deserialize → apply ops → serialize → save
```

This is **expensive** because it requires loading the full document into memory for every sync.

Instead, DocSync uses **lazy application**:

```
receive operations → append to operations table (done!)
```

This is extremely cheap—just an INSERT. No document loading required.

Periodically, a **squash** operation applies accumulated operations to the document and discards them.

## Data Model

### Server Database

```
┌─────────────────────────────────────────────────────────────┐
│ documents                                                   │
├─────────────────────────────────────────────────────────────┤
│ docId        │ Primary key                                  │
│ doc          │ Serialized document                          │
│ clock        │ Version of the serialized document           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ operations                                                  │
├─────────────────────────────────────────────────────────────┤
│ docId        │ Foreign key to documents                     │
│ operation    │ The operation data                           │
│ clock        │ Assigned by server on INSERT (timestamp)     │
└─────────────────────────────────────────────────────────────┘
```

**Key insight**: The document's clock represents the version of the _serialized_ document. Operations with `clock > document.clock` have not yet been applied to the serialized document.

### Client Storage

```
┌─────────────────────────────────────────────────────────────┐
│ docs (local)                                                │
├─────────────────────────────────────────────────────────────┤
│ docId        │ Primary key                                  │
│ doc          │ Serialized document                          │
│ clock        │ Last known server clock                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ operations (local)                                          │
├─────────────────────────────────────────────────────────────┤
│ docId        │ Document this operation belongs to           │
│ operation    │ The operation data                           │
│ (no clock)   │ Clock is assigned by server, not client      │
└─────────────────────────────────────────────────────────────┘
```

**Important**: The client NEVER writes directly to `docs`. It only appends to `operations`. The `docs` store is only updated after a successful sync.

## Sync Flow

### Step-by-Step

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CLIENT                           │ SERVER                                │
├──────────────────────────────────┼───────────────────────────────────────┤
│ 1. User makes edits              │                                       │
│    → Operations saved to         │                                       │
│      local operations store      │                                       │
│                                  │                                       │
│ 2. Sync triggered                │                                       │
│    → Gather unsent operations    │                                       │
│    → Read current doc clock      │                                       │
│                                  │                                       │
│ 3. Send to server:               │                                       │
│    {                             │                                       │
│      docId,                      │                                       │
│      operations: [...],          │                                       │
│      clock: 1704067200           │                                       │
│    }                             │                                       │
│                                  │                                       │
│                                  │ 4. Server receives request            │
│                                  │    → Append operations with new clock │
│                                  │    → Find operations where            │
│                                  │      clock > client's clock           │
│                                  │    → Return missing operations        │
│                                  │                                       │
│ 5. Receive response:             │                                       │
│    {                             │                                       │
│      operations: [...],  // missing ops                                  │
│      clock: 1704067500   // latest clock                                 │
│    }                             │                                       │
│                                  │                                       │
│ 6. Consolidate locally:          │                                       │
│    → Load doc from local store   │                                       │
│    → Deserialize                 │                                       │
│    → Apply server ops            │                                       │
│    → Apply own ops               │                                       │
│    → Serialize                   │                                       │
│    → Save to docs with new clock │                                       │
│    → Clear local operations      │                                       │
└──────────────────────────────────┴───────────────────────────────────────┘
```

### The Client's Message to the Server

When syncing, the client essentially says:

> "Starting from version X of the document, I applied these operations. If any operations were applied between version X and now, please send them to me so I can apply them locally."

### Server's Response

The server:

1. **Appends** the client's operations to the operations table (assigns clock = current timestamp)
2. **Queries** operations where `clock > client's clock` (excluding the ones just inserted)
3. **Returns** those operations + the latest clock

## Squash Operation

Over time, the operations table accumulates entries. Periodically, a **squash** consolidates them:

```
1. Load serialized document
2. Deserialize
3. Query all operations where clock > document.clock
4. Apply operations in clock order
5. Serialize
6. Save document with new clock = max(operation clocks)
7. Delete applied operations
```

This can run:

- On a schedule (cron job)
- When operation count exceeds a threshold
- On document access (if stale)

---

## Open Questions

### 1. Operation Ordering Within a Single Sync

When a client sends multiple operations in one sync, they arrive together. Should they:

- All get the same clock (current timestamp)?
- Each get a sequential clock (timestamp + microseconds or sequence number)?

**Consideration**: If two clients sync at the exact same moment, their operations would interleave randomly if using pure timestamps.

### 2. Conflict Resolution

This model assumes operations are **commutative** or that the application layer handles conflicts. What happens when:

- Client A and Client B both edit the same field?
- The order of application matters?

**Current assumption**: DocNode's CRDT-like operations handle this at the operation level.

### 3. What to Return: Operations vs. Serialized Document?

The current model returns only operations. Should the server also return the serialized document in some cases?

- **Operations only**: Client applies them to local doc (current approach)
- **Serialized doc**: Useful if client is too far behind or for initial load
- **Hybrid**: Return doc if operation count > threshold

### 4. Client Offline → Online with Many Pending Operations

If a client was offline for a long time and accumulated many operations:

- Should they all be sent in one sync?
- Should they be batched?
- What if the server squashed multiple times in between?

### 5. Multi-Document Sync

The current sync request is an array of documents. Questions:

- Should it be transactional across all documents?
- What if one document fails but others succeed?

### 6. Clock Type: Integer vs. Timestamp

| Aspect               | Integer            | Timestamp            |
| -------------------- | ------------------ | -------------------- |
| Simplicity           | Simpler            | Slightly complex     |
| Ordering guarantee   | Perfect            | Depends on precision |
| `updatedAt` for free | No                 | Yes                  |
| Cross-server sync    | Needs coordination | Naturally sortable   |

**Recommendation**: Use high-precision timestamp (`timestamp(6)` or similar) for both ordering and auditing.

### 7. Deleted Operations After Squash

After squash, operations are deleted. What if a very slow client syncs with a clock older than the oldest remaining operation?

**Options**:

- Force full document reload
- Keep a "minimum clock" and reject too-old syncs
- Archive operations instead of deleting

---

## Implementation Checklist

- [ ] Add `clock` (timestamp) column to operations table
- [ ] Server: INSERT operations with `clock = NOW()`
- [ ] Server: SELECT operations WHERE `docId = ? AND clock > ?`
- [ ] Server: Exclude just-inserted operations from response
- [ ] Client: Apply server operations + own operations
- [ ] Client: Update local doc with new clock
- [ ] Squash: Implement periodic consolidation
