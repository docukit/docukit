# DocNode-Lexical Integration Design Document

## TL;DR - How It Works

**The Problem:** Keep Lexical editor and DocNode document in sync (bidirectional).

**The Solution:**

- **Lexical → DocNode:** Simple DFS with dirty tracking (skip clean nodes)
- **DocNode → Lexical:** Rebuild strategy (clear + recreate from DocNode tree)

```typescript
User types (Lexical → DocNode):
  1. Check what changed (dirtyElements + dirtyLeaves)
  2. Iterate children in order, skip clean nodes (O(1) check)
  3. Update/Create/Delete/Move as needed

Remote edit (DocNode → Lexical):
  1. Clear Lexical tree
  2. Rebuild from DocNode (parse serialized JSON)
  3. Update bidirectional mappings
```

**Key Insight:** Lexical's `dirtyElements`/`dirtyLeaves` make sync trivial. DocNode's auto-batching and deep-comparison eliminate manual diff logic.

**Status:** ✅ Full bidirectional sync (16/16 tests passing)

---

## Overview

This document outlines the design and implementation strategies for `docnode-lexical`, a binding between [Lexical](https://lexical.dev) editor and [DocNode](https://docukit.dev), a modern alternative to Yjs for collaborative editing.

DocNode differs from Yjs in its approach:

- **Automatic transaction batching** (no need for explicit `doc.transact()`)
- **Compact inverse operations** for undo/redo instead of full state snapshots
- **Built-in normalization phase** for enforcing document structure
- **Clear lifecycle stages**: idle → update → normalize → change

## Background: How Lexical-Yjs Works

### Two-Way Synchronization

The existing Lexical-Yjs integration uses two parallel sync mechanisms:

#### 1. **Yjs → Lexical** (Remote changes)

```typescript
root.getSharedType().observeDeep(onYjsTreeChanges);

const onYjsTreeChanges = (events, transaction) => {
  if (origin !== binding) {
    syncYjsChangesToLexical(binding, provider, events, isFromUndoManager);
  }
};
```

#### 2. **Lexical → Yjs** (Local changes)

```typescript
editor.registerUpdateListener(
  ({
    prevEditorState,
    editorState,
    dirtyElements,
    dirtyLeaves,
    normalizedNodes,
    tags,
  }) => {
    syncLexicalUpdateToYjs(
      binding,
      provider,
      prevEditorState,
      editorState,
      dirtyElements,
      dirtyLeaves,
      normalizedNodes,
      tags,
    );
  },
);
```

**Key Insight:** Yjs uses `.observeDeep()` (not `.addEventListener()`), while Lexical uses `.registerUpdateListener()` for the binding.

## Core Concepts

### 1. Dirty Nodes vs Mutated Nodes

Understanding the difference is crucial:

| Aspect           | Dirty Nodes                                      | Mutated Nodes                                   |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| **When set**     | During update (when `node.getWritable()` called) | After reconciliation (DOM diffing)              |
| **Purpose**      | Track which nodes changed in EditorState         | Track DOM mutations (created/updated/destroyed) |
| **Availability** | Always available in UpdateListener               | Only if `MutationListener` registered           |
| **Contains**     | `dirtyElements` (Map) + `dirtyLeaves` (Set)      | Map of `NodeKey → NodeMutation`                 |
| **Used for**     | Determining what to sync                         | Observing final DOM changes                     |

### 2. Node Mutation Lifecycle

Node mutations follow strict rules:

```typescript
export type NodeMutation = "created" | "updated" | "destroyed";
```

**Key Rule:** First mutation wins (with one exception)

```typescript
const prevMutation = mutatedNodesByType.get(nodeKey);
const isMove = prevMutation === "destroyed" && mutation === "created";
if (prevMutation === undefined || isMove) {
  mutatedNodesByType.set(nodeKey, isMove ? "updated" : mutation);
}
```

**Special Cases:**

- `destroyed` + `created` → `updated` (move detection)
- `updated` + `created` → `updated` (first wins)
- `updated` + `destroyed` → `updated` (happens when `updateDOM()` returns true)

### 3. The Reconciliation Algorithm

All three systems (Lexical Reconciler, Yjs V1, Yjs V2) use similar **two-pointer diff algorithms**:

```typescript
// Common pattern across all implementations
while (prevIndex <= prevEndIndex && nextIndex <= nextEndIndex) {
  const prevKey = prevChildren[prevIndex];
  const nextKey = nextChildren[nextIndex];

  if (prevKey === nextKey) {
    // Update existing node
    reconcile(nextKey);
    prevIndex++;
    nextIndex++;
  } else {
    // Lazy create Sets for O(1) lookup
    if (!prevChildrenSet) prevChildrenSet = new Set(prevChildren);
    if (!nextChildrenSet) nextChildrenSet = new Set(nextChildren);

    const nextHasPrevKey = nextChildrenSet.has(prevKey);
    const prevHasNextKey = prevChildrenSet.has(nextKey);

    if (!nextHasPrevKey) {
      // Remove
    } else if (!prevHasNextKey) {
      // Create
    } else {
      // Move
    }
  }
}
```

#### Comparative Analysis

| Aspect                | Reconciler (DOM)                          | Yjs V1                              | Yjs V2                               |
| --------------------- | ----------------------------------------- | ----------------------------------- | ------------------------------------ |
| **Objective**         | Update DOM                                | Update Yjs                          | Update Yjs                           |
| **Base structure**    | Two-pointer                               | Two-pointer                         | Two-pointer bidirectional            |
| **Compares**          | `prevNodeMap ↔ nextNodeMap`               | `prevNodeMap ↔ nextNodeMap`         | `yChildren ↔ lChildren`              |
| **When keys match**   | `$reconcileNode()` + update DOM           | `_syncChildFromLexical()` recursive | **Optimizes:** only if dirty         |
| **Detects moves**     | ✅ Yes                                    | ✅ Yes                              | ✅ Yes                               |
| **Lazy Sets**         | ✅ Only creates if diff                   | ✅ Only creates if diff             | ❌ Doesn't use sets                  |
| **Creates mutations** | ✅ `setMutatedNode()`                     | ❌ No                               | ❌ No                                |
| **Uses dirty check**  | ✅ To skip updates                        | ✅ Passes `dirtyElements`           | ✅ **Uses to skip recursion**        |
| **Tail handling**     | `$createChildren()` / `destroyChildren()` | Manual loop                         | `yDomFragment.delete()` / `insert()` |

## Implementation Approach: Simple DFS with Dirty Tracking

### Core Algorithm

```typescript
function $syncLexicalToDocNode(doc, docParent, lexicalNode, dirtyElements, dirtyLeaves, ...) {
  // 1. Build map of existing DocNode children (O(1) lookup)
  const docChildrenMap = new Map();
  let docChild = docParent.first;
  while (docChild) {
    docChildrenMap.set(docChild.id, docChild);
    docChild = docChild.next;
  }

  // 2. Process each Lexical child in order
  let prevDocChild;
  for (const lexicalChild of lexicalNode.getChildren()) {
    const mappedDocNodeId = map.get(lexicalChild.key);

    if (mappedDocNodeId && docChildrenMap.has(mappedDocNodeId)) {
      // EXISTS → Update + maybe move
      const docNode = docChildrenMap.get(mappedDocNodeId);
      $syncNodeContent(docNode, lexicalChild, dirtyElements, dirtyLeaves);

      if (needsMove) docNode.move(prevDocChild, 'after');
      prevDocChild = docNode;
    } else {
      // NEW → Create
      const newNode = createDocNodeFromLexical(lexicalChild, ...);
      prevDocChild ? prevDocChild.insertAfter(newNode) : docParent.prepend(newNode);
      prevDocChild = newNode;
    }
  }

  // 3. Delete unused DocNodes
  for (const [id, node] of docChildrenMap) {
    if (!seen.has(id)) node.delete();
  }
}

function $syncNodeContent(docNode, lexicalNode, dirtyElements, dirtyLeaves) {
  const isDirty = dirtyElements.has(key) || dirtyLeaves.has(key);
  if (!isDirty) return; // ← Skip clean nodes!

  docNode.state.j.set(lexicalNode.exportJSON());

  if ($isElementNode(lexicalNode)) {
    $syncLexicalToDocNode(doc, docNode, lexicalNode, ...);
  }
}
```

**Why this works:**

- ✅ **Dirty tracking** - Skip 99% of nodes that didn't change
- ✅ **Single pass** - No complex bidirectional scanning needed
- ✅ **Minimal ops** - Uses `.move()` for repositioning, not delete+create
- ✅ **~60 lines** - Simple and maintainable

### Example: Insert Paragraph in Middle

```
Before: [P1("Hello")] [P2("World")]
After:  [P1("Hello")] [P_NEW("Middle")] [P2("World")]

Sync Process:
  1. P1: exists, not dirty → skip content update
  2. P_NEW: doesn't exist → create + insert
  3. P2: exists, wrong position → move after P_NEW

Operations: 1 create + 1 move
```

### Example: Edit Text

```
Before: [P1(TextNode("Hello"))]
After:  [P1(TextNode("Hello World!"))]

dirtyElements: {'root', 'p1'}
dirtyLeaves: {'text1'}

Sync Process:
  1. P1: dirty (in dirtyElements) → update content
  2. TextNode: dirty (in dirtyLeaves) → update content

Operations: 2 updates
```

## Node Mapping Strategy

**Simple:** One universal `LexicalDocNode` type stores any Lexical node's JSON:

```typescript
export const LexicalDocNode = defineNode({
  state: { j: defineState({ fromJSON: (json) => json ?? {} }) },
  type: "l",
});
```

Benefits: Works with all node types, forward-compatible, minimal code.

## DocNode-Specific Considerations

### 1. Transaction Handling

DocNode auto-batches mutations in the same microtask:

```typescript
editor.registerUpdateListener(() => {
  // All these mutations auto-batch into one DocNode transaction
  docNode.append(child1);
  docNode.state.j.set(serializedNode);
  child1.state.j.set(serializedChild);
  // DocNode fires onChange once after microtask completes
});
```

### 2. Sync Loop Prevention

Use tags to prevent infinite sync loops:

```typescript
// Lexical → DocNode
editor.registerUpdateListener(({ tags }) => {
  if (tags.has("docnode")) return; // Skip changes from DocNode
  // Sync to DocNode
});

// DocNode → Lexical
doc.onChange(() => {
  editor.update(
    () => {
      $addUpdateTag("docnode");
      // Apply DocNode changes to Lexical
    },
    { tag: "docnode" },
  );
});
```

### 3. Normalization Phase

DocNode's normalization can enforce Lexical constraints:

```typescript
const LexicalDocNodeExtension: Extension = {
  register(doc) {
    doc.onNormalize(({ diff }) => {
      // Enforce Lexical-specific rules
      // E.g., root must have at least one paragraph
      if (doc.root.children.length === 0) {
        const paragraph = doc.createNode(LexicalDocNode);
        paragraph.state.j.set({ type: "paragraph", children: [] });
        doc.root.append(paragraph);
      }
    });
  },
};
```

## Serialization Strategy

Since we're using Lexical's serialization:

```typescript
// Lexical → DocNode
const serialized = lexicalNode.exportJSON();
docNode.state.j.set(serialized);

// DocNode → Lexical
const serialized = docNode.state.j.get();
const lexicalNode = $parseSerializedNode(serialized);
```

This leverages Lexical's existing `exportJSON()` and node creation from JSON.

## References

- [Lexical Reconciler](../lexical/src/LexicalReconciler.ts) - Dirty tracking pattern
- [DocNode Docs](https://docukit.dev/llms-full.txt) - Full API reference
- [Implementation](./src/index.ts) - Current code

## Implementation Status

### ✅ Completed (v1.0)

#### 1. **Lexical → DocNode Sync** (`$syncLexicalToDocNode`)

- Simple DFS with dirty tracking (`dirtyElements` + `dirtyLeaves`)
- Early returns for clean nodes (O(1) dirty check with `||` operator)
- Proper move detection (uses `.move()` not delete+create)
- DocNode auto deep-comparison (no manual `JSON.stringify()` needed)
- **8 tests passing** in `syncLexicalToDocNode.test.ts`

#### 2. **DocNode → Lexical Sync** (`$syncDocNodeToLexical`)

- Rebuild strategy: clear Lexical tree + recreate from DocNode
- Recursive `createLexicalFromDocNode()` using `$parseSerializedNode()`
- Bidirectional mapping updates (cleanup deleted nodes)
- Auto-batching with `doc.onChange()` + `doc.forceCommit()`
- **6 tests passing** in `syncDocNodeToLexical.test.ts`

#### 3. **Infrastructure**

- ✅ Infinite loop prevention (tag: `'docnode'`)
- ✅ Auto transaction batching (DocNode microtask + Lexical `discrete: true`)
- ✅ Bidirectional key ↔ id mappings
- ✅ Support for all node types via universal `LexicalDocNode`

#### 4. **Tests: 16/16 passing** ✅

- `syncLexicalToDocNode.test.ts`: 8 tests (create, update, delete, move, complex edits)
- `syncDocNodeToLexical.test.ts`: 6 tests (reverse direction)
- `batching.test.ts`: 2 tests (auto-batching verification)

### 📋 Next Steps

1. **Collaboration testing** (multi-client sync)
2. **Optimize DocNode → Lexical** (diff instead of rebuild)
3. **Selection/cursor sync** (awareness)
4. **Normalized nodes handling**
5. **Performance benchmarks vs Yjs**

---

**Document Version:** 4.0  
**Last Updated:** 2025-12-07  
**Status:** ✅ Full bidirectional sync implemented and tested (16/16 tests)  
**Author:** Based on technical conversation analyzing Lexical-Yjs implementation
