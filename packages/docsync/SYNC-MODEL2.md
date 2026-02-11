# DocSync: Synchronization Model

This document explains the synchronization model used by DocSync, a central-server sync system for collaborative documents.

## Core Concepts

### 1. The Clock

Every document has a **clock** that represents its version. The clock is a timestamp assigned by the server when operations are stored. Only the server can advance the clock, ensuring a deterministic global order across all clients.

> **Note**: While the clock could be an auto-incrementing integer, we recommend using a timestamp because it doubles as an `updatedAt` field. This is an implementation detail left to each `ServerProvider`.

### 2. Storage Architecture

#### Client Storage

The client maintains two stores:

| Store        | Purpose                                      | Has Clock? |
| ------------ | -------------------------------------------- | ---------- |
| `docs`       | Serialized documents certified by the server | ✅ Yes     |
| `operations` | Pending local operations not yet synced      | ❌ No      |

**Key rule**: The client never writes directly to `docs`. It only appends to `operations`.

#### Server Storage

| Table        | Purpose                               | Clock                  |
| ------------ | ------------------------------------- | ---------------------- |
| `documents`  | Serialized documents                  | ✅ Document version    |
| `operations` | Accumulated operations pending squash | ✅ Insertion timestamp |

---

## Why This Architecture?

### The Cost of Immediate Application

A naive approach would apply every incoming operation immediately:

```
receive operations → load doc → deserialize → apply ops → serialize → save
```

This is expensive because it requires loading the entire document into memory for every sync request.

### The Append-Only Approach

Instead, DocSync uses an append-only strategy:

```
receive operations → append to operations table (with timestamp)
```

This is extremely cheap—just a database insert. The client doesn't even need to debounce sync requests.

### Squashing

Periodically, the server performs a **squash**:

1. Load the serialized document
2. Load all pending operations
3. Apply operations to the document
4. Save the updated document with a new clock
5. Delete the applied operations

This amortizes the expensive deserialization/serialization cost across many operations.

---

## The Sync Flow

### Client Perspective

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. User makes changes                                              │
│     └─→ Operations saved to local `operations` store                │
│                                                                     │
│  2. Sync triggered (single document at a time)                      │
│     └─→ Read local doc clock from `docs` store                      │
│     └─→ Read pending operations from `operations` store             │
│     └─→ Send to server: { docId, clock, operations[] }              │
│                                                                     │
│  3. Receive server response                                         │
│     └─→ Server returns: { operations[], serializedDoc, clock }      │
│     └─→ If server sent operations, client was behind                │
│     └─→ serializedDoc returned only if doc.clock > clientClock      │
│                                                                     │
│  4. Reconcile locally                                               │
│     └─→ Load doc from `docs` store                                  │
│     └─→ Apply server operations (if any)                            │
│     └─→ Apply own operations (already applied to in-memory doc)     │
│     └─→ Save doc with new clock to `docs` store                     │
│     └─→ Clear synced operations from `operations` store             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Server Perspective

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SERVER                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Receive sync request: { docId, clock, operations[] }            │
│     └─→ "Starting from version X, I applied these operations.       │
│          Give me any operations I'm missing."                       │
│                                                                     │
│  2. Find operations the client doesn't have (BEFORE insert!)        │
│     └─→ SELECT operations FROM "docsync-operations"                 │
│         WHERE docId = ? AND clock > clientClock                     │
│         ORDER BY clock                                              │
│                                                                     │
│  3. Append client operations and get the assigned clock             │
│     └─→ INSERT INTO "docsync-operations" (docId, operations)        │
│         VALUES (?, ?)                                               │
│         RETURNING clock                                             │
│                                                                     │
│  4. Return missing operations + newly inserted clock to client      │
│     └─→ { operations[], clock: insertedClock }                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Key**: We query BEFORE inserting so the client doesn't receive their own operations back. The clock returned is from the newly inserted row (via `RETURNING`), not from existing operations.

### Sequence Diagram

```
Client A          Server          Client B
   │                 │                 │
   │  sync(clock=0,  │                 │
   │   ops=[A1,A2])  │                 │
   │────────────────>│                 │
   │                 │ store A1,A2     │
   │                 │ with clock=T1   │
   │  { ops=[], T1 } │                 │
   │<────────────────│                 │
   │                 │                 │
   │                 │  sync(clock=0,  │
   │                 │   ops=[B1])     │
   │                 │<────────────────│
   │                 │ store B1        │
   │                 │ with clock=T2   │
   │                 │                 │
   │                 │ { ops=[A1,A2],  │
   │                 │   clock=T2 }    │
   │                 │────────────────>│
   │                 │                 │
   │                 │     Client B now has A1,A2,B1
   │                 │     and clock=T2
```

---

## Data Model

### Documents Table

```sql
CREATE TABLE "docsync-documents" (
  "docId"     VARCHAR(26) PRIMARY KEY,
  doc         JSONB NOT NULL,           -- Serialized document
  clock       TIMESTAMP NOT NULL,       -- Last squash timestamp
  "userId"    VARCHAR(26)               -- Optional: owner
);
```

### Operations Table

```sql
CREATE TABLE "docsync-operations" (
  "docId"     VARCHAR(26) NOT NULL,
  operations  JSONB NOT NULL,           -- Array of operations from one sync
  clock       TIMESTAMP NOT NULL        -- Assigned by server on insert
                DEFAULT NOW()
);

CREATE INDEX idx_operations_doc_clock ON "docsync-operations"("docId", clock);
```

**Note**: Each row contains an **array** of operations from a single sync request, not individual operations.

---

## Open Questions

### 1. When does squashing happen?

Options:

- **On-demand**: When a client requests a document that has too many pending operations
- **Scheduled**: Background job that periodically squashes documents with pending operations
- **Threshold-based**: When operations count exceeds N, trigger squash
- **Hybrid**: Combination of the above

### 2. What if a client is offline for a long time?

If operations accumulate significantly:

- Should we force a full document resync?
- Should we limit how many operations we return?
- Should we automatically squash before responding?

### 3. How do we handle the serializedDoc in sync responses?

Current design only returns operations. But after a squash, the client's local doc might be stale. Options:

- Always return `{ serializedDoc, operations }` and let client decide
- Return serializedDoc only after squash events
- Add a flag indicating if client needs full doc refresh

### 4. Conflict resolution

DocSync assumes the underlying document type (e.g., docnode) handles conflicts via CRDTs or OT. But:

- What if operation order matters?
- How do we ensure operations are applied in clock order?
- Should the server ever reject operations?

### 5. Clock granularity

If using timestamps:

- What precision? (milliseconds, microseconds?)
- What happens if two operations arrive at the exact same timestamp?
- Should we add a sequence number as a tiebreaker?

### 6. Partial sync

For large documents with many operations:

- Should we paginate operation responses?
- Should we support delta sync for specific document subtrees?

---

## Implementation Checklist

- [x] Add `clock` (timestamp) column to operations table
- [x] Implement `sync` method in PostgresProvider
- [x] Single-document sync (not array)
- [x] Operations stored as array per row
- [x] Use `RETURNING` to get inserted clock
- [x] Query operations BEFORE insert
- [x] Only fetch serializedDoc if doc.clock > clientClock
- [ ] Implement squash logic (separate method/job)
- [ ] Define when squashing is triggered
- [ ] Handle edge case: first sync with no existing document
- [ ] Add clock precision/tiebreaker strategy
