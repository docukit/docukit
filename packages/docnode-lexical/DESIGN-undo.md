# Undo, selection, and remote ops in DocNode + Lexical

Working notes on the design problems we have to solve. Captures the discussion so future sessions don't have to re-derive it.

## Where this came from

The home-page demo had a bug: pressing Cmd/Ctrl+Z reverted only the active panel; the others stayed on the post-typing state. Root cause: Lexical's `HistoryPlugin.undo()` calls `editor.setEditorState(prev, { tag: HISTORIC_TAG })`, which sets `_dirtyType = FULL_RECONCILE` and only marks `'root'` in `_dirtyElements`. `syncLexicalToDocNode`'s dirty-skip optimization then walks into root, finds no dirty children, and never propagates the reverted content to DocNode. Other editors stay stale.

We fixed that by routing UNDO/REDO through DocNode's UndoManager: `setupUndoManager` registers `UNDO_COMMAND`/`REDO_COMMAND` at `COMMAND_PRIORITY_HIGH` and calls `undoManager.undo()` / `.redo()`. DocNode's UndoManager applies inverse operations on the doc, which propagate via DocSync to all panels. `HistoryPlugin` is intercepted before it can run.

Two follow-up problems surfaced from this fix.

## Problem 1 — Cursor jumps after undo (IndexSizeError)

`UndoManager` records only `Operations`, not selection. When the undo applies, Lexical's stale `editorState._selection` (e.g. offset 4 on now-3-char text) throws `IndexSizeError: offset 4 is larger than node's length (3)` and the caret lands somewhere unexpected (typically start of the block).

`HistoryPlugin` did not have this problem because it stored the entire `EditorState` (including selection) per snapshot.

## Problem 2 — Remote ops are recorded in the undo stack

`UndoManager` listens to `doc.onChange` and pushes every change. When user A types and DocSync broadcasts, user B's UndoManager also records the operation. If user B presses Cmd/Ctrl+Z they undo user A's edit. Wrong.

These two are the same architectural problem dressed differently: the UndoManager has no way to tell **which transactions to track** and **what metadata to associate with each step**.

## Sub-problems for selection

When deciding "after this change, where should the cursor end up", three independent questions:

1. Cursor at a boundary, a remote user inserts there. Stickiness decides: does the inserted text appear left or right of my caret?
2. A remote user deletes the content I had selected. Where does my caret fall back to?
3. I press undo and concurrent remote edits happened during my typing. Which selection do I restore — mine from before the edit, mapped through the rebases?

## What other tools do

- **Yjs / y-prosemirror**: `RelativePosition` (anchored to Yjs item ID + `assoc` for stickiness). UndoManager has `stackItem.meta: Map` per step + events `stack-item-added` / `stack-item-popped`. y-prosemirror saves the **pre-edit** selection on push (relative positions); restores on pop. On remote ops the local cursor is mapped through ProseMirror's normal step maps.
- **Loro / loro-prosemirror**: `Cursor` with `Side` (`Left`/`Default`/`Right`). When a target is deleted, `getCursorPos` replays history to find the nearest live element. UndoManager's `onPush`/`onPop` hooks store/restore selection.
- **Automerge**: `Cursor` API; floats with insertions/deletions.
- **lexical-yjs (V1)**: saves selection in awareness (not in UndoManager meta). Recovery heuristic when a node is gone: prev sibling → parent → recurse → root.start.
- **Lexical's HistoryPlugin** (single-user only): stores the full `EditorState` per snapshot. No CRDT awareness.

## Convergent recommendations

1. Use stable positions (anchored to content IDs), not absolute indices.
2. Save the **pre-edit** selection at push time.
3. Filter the undo stack by an opaque **origin** attached to each transaction.
4. The UndoManager keeps a free-form `meta` per step and exposes lifecycle events; the binding owns selection-specific code.
5. When a stable position resolves to deleted content, fall back via a tree-walk heuristic (sibling → parent → root). Don't collapse to doc start.

## Decisions agreed on

- `Doc.applyOperations(ops, ctx?)` accepts an opaque `ctx`. `onChange`'s payload gains an optional `ctx` field. DocNode core stays CRDT-agnostic — `ctx` is opaque to it.
- Local edits via direct mutators (paragraph.append, state.j.set, etc.) do not need `ctx`; absence-of-ctx implicitly means "local".
- `UndoManager` filters by `ctx` (predicate config) and stores a free-form `meta` per step.
- `UndoManager` exposes `onPush` / `onPop` lifecycle events. The binding subscribes and writes/reads `meta`. **(Done.)**
- The binding (`docnode-lexical`) owns selection capture and restore. Stable position format: `PresenceSelection` from `types.ts:8` (`{anchor: {key: docNodeId, offset}, focus: {key: docNodeId, offset}}`). Already exists, used for awareness.
- For deleted nodes, recovery heuristic mirrors `lexical-yjs`'s `$moveSelectionToPreviousNode`: prev sibling → parent → recurse → root.

## Decisions still open

- Do we add stickiness/`assoc`/`side` to `PresenceSelection`? Required for cursor-at-boundary semantics matching Yjs/Loro. Probably YES later, NO for v1.
- Do we add `Doc.transact(fn, ctx?)` for explicit transactions? DocNode already auto-batches per microtask, so it's optional. Adds a clean attach-ctx-to-direct-mutations path. Probably YES eventually.
- Selection format on the undo step: `PresenceSelection` directly, or wrap it with version/fallback metadata?

## Pending implementation work

1. Extend `Doc.applyOperations` and `doc.onChange` payload with optional `ctx`.
2. Extend `UndoManager` constructor with `trackedOrigins` (or `shouldRecord`) predicate.
3. In `docnode-lexical`: on `syncDocNodeToLexical` apply pass `ctx = { origin: "remote" }`; in `setupUndoManager` subscribe to `onPush` / `onPop`, capture `prevEditorState._selection` → `PresenceSelection` on push, restore on pop; implement deleted-node fallback (port `$moveSelectionToPreviousNode`).
4. Regression test: typing during a remote edit, undo, both editors revert AND the local cursor lands on a sensible position.
