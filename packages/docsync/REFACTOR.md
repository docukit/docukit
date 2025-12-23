# DocSync Refactoring

## Problem

`DocSyncClient` is a monolithic class (~300 lines) mixing responsibilities:

1. **In-memory document management** (cache, refCount)
2. **Cross-tab synchronization** (BroadcastChannel)
3. **Local persistence** (IndexedDB)
4. **Server synchronization** (API, push/pull)

This makes the code hard to understand and maintain.

## Solution

Split into two modules based on data flow:

```
memory ←→ IndexedDB ←→ Server
   └── DocSyncClient ──┘   └── ServerSync ──┘
```

### Module 1: `DocSyncClient` (memory ↔ IndexedDB)

Responsibilities:

- In-memory document cache
- Cross-tab broadcast
- Save operations to IndexedDB
- Notify when saved (`onSaved`)

### Module 2: `ServerSync` (IndexedDB ↔ Server)

Responsibilities:

- Listen to `onSaved` from module 1
- Push operations to server
- Sync state management (idle/pushing/pending)

## Current Status

- [x] Create `ServerSync` class with push logic
- [x] Move `pushOperations` from `DocSyncClient` to `ServerSync`
- [x] Connect via `onSaved()` callback
- [ ] Move `saveSerializedDoc` logic after successful push
- [ ] Add pull from server
- [ ] Unit tests for `ServerSync`

## Code

```typescript
// In DocSyncClient
async onLocalOperations({ docId, operations }: OpsPayload<O>) {
  await this._local?.provider.saveOperations({ docId, operations });
  this._serverSync?.onSaved();  // ← notifies server module
}

// ServerSync
onSaved() {
  if (this._pushStatus !== "idle") {
    this._pushStatus = "pushing-with-pending";
    return;
  }
  void this._push();
}
```
