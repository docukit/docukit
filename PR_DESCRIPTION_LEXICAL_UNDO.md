# Lexical undo and remote selection

This PR fixes two different problems in the DocNode + Lexical integration.

## 1. Local undo/redo must go through DocNode

The original demo used Lexical's own history. The active editor did update, but
that undo was not reliably propagated into DocNode\*, so the other synced
panels could stay stale.

The fix is to route Lexical's `UNDO_COMMAND` and `REDO_COMMAND` through
DocNode's `UndoManager` instead:

- `setupUndoManager.ts` intercepts Lexical undo/redo commands
- it calls `undoManager.undo()` / `undoManager.redo()`
- DocNode applies inverse operations to the shared document
- those document changes then propagate normally to every synced editor

This file also solves the selection part of local undo/redo:

- before a stack item is finalized, it stores selection metadata with
  `onPush(...)`
- after undo or redo applies, it restores that metadata with `onPop(...)`

That is why local undo/redo now restores both:

- the document content
- the local selection

It also uses transaction `origin` so changes whose origin starts with
`remote` are not recorded in the local undo stack.

In DocSync, changes received through BroadcastChannel from another tab on the
same device are treated as local for undo purposes. They may look "remote" in
the sense that they came from a different tab, but they still belong to the
same local editing session. Tagging them as local lets different tabs share one
logical undo history instead of each tab building an isolated one.

## 2. Remote edits should only remap the current selection

This is a different problem.

When a remote operation changes text that overlaps the local selection,
`transformSelection.ts` adjusts the current selection immediately so the
cursor or range still points to a sensible place.

The important rule is:

- remote edits may transform the current selection
- remote edits do not create future selection history for this editor

So if another device later presses undo, that undo is still remote from this
editor's point of view. The local selection should not be "restored" as if the
undo had happened locally.

That is why the remote-selection tests were simplified:

- they now verify how the selection changes immediately after the remote edit
- local selection restoration is tested separately in the undo tests

## Result

After this PR:

- Lexical undo/redo now goes through DocNode's `UndoManager`, so undo is
  applied through the shared document instead of Lexical's local history.
- Local undo/redo restores local selection by storing metadata on undo stack
  items and reading it back on pop.
- `UndoManager` now exposes three methods that are relevant to this work:
  `clear()`, `onPush(...)`, and `onPop(...)`.
- Remote changes whose origin starts with `remote` are not added to the local
  undo stack.
- DocSync: BroadcastChannel changes coming from another tab on the same device are
  intentionally treated as local for undo purposes, so tabs share one logical
  undo history instead of separate per-tab histories.
- Remote edits still transform the current local selection immediately.
- Remote undo is still treated as remote, so it does not try to restore local
  selection history in another editor.
- The remote-selection behavior now lives in `transformSelection.ts`, separated
  from local undo/redo selection restoration in `setupUndoManager.ts`.
- The docs now cover `origin`, `doc.applyOperations(operations, origin)`, and
  the `UndoManager` stack lifecycle hooks.

\* Lexical's HistoryPlugin restores editor state in a way that did not match the
incremental dirty-check used by `syncLexicalToDocNode.ts`. The active editor
changed, but the binding could miss the corresponding DocNode update, so the
other synced editors would not always receive that undo.
