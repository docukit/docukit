# PR Description

## Summary

This PR integrates `UndoManager` into `Doc` as `doc.undoManager`, configures it through `DocConfig`, and replaces ad-hoc transaction `origin` strings with an explicit `skipUndo` transaction flag.

The main user-facing change is that consumers no longer instantiate or pass an `UndoManager` separately. Instead, each `Doc` owns one undo manager, disabled by default unless `undoManager.maxUndoSteps` is configured:

```ts
const doc = new Doc({
  type: "root",
  extensions: [MyExtension],
  undoManager: { maxUndoSteps: 100 },
});

doc.undoManager.undo();
doc.undoManager.redo();
```

## Context

My original plan was to keep `UndoManager` as a separate class, decoupled from `Doc`, for three reasons. I decided to undo that separation and integrate the undo manager into `Doc` after revisiting each tradeoff:

- Tree shaking: if an app did not use an undo manager, I wanted the undo-manager code to be removable from the bundle.
  - Counterargument: the undo manager is roughly 120 lines of code, so the bundle impact is small compared with the API and lifecycle complexity caused by keeping it separate.
- Future persistence: I thought someone might eventually want a persisted undo manager, where undo and redo operations are stored in `localStorage` or IndexedDB. That would let a user leave a note, come back later, and continue undoing or redoing operations, similar to how VS Code can preserve edit history across files.
  - Counterargument: this can still be supported by exposing a couple of methods on the native undo manager, without requiring every consumer and binding to manage a separate undo-manager instance.
- More modular structure: keeping undo separate from `Doc` made the architecture feel less coupled and kept ownership explicit.
  - Counterargument: in practice, this created complexity in packages like `@docukit/docnode-lexical`, where the binding needs to configure and coordinate undo behavior. Because there was no one-to-one relationship between a `Doc` and an `UndoManager`, and because users had to create the manager themselves, the Lexical integration needed extra props, a `WeakMap`, and lifecycle logic just to provide a reasonable default. That felt too complex for something that should work out of the box.

## Undo Manager Integration

The main API change is that undo is now configured on `DocConfig` and accessed through `doc.undoManager`.

Undo is still opt-in at runtime. `maxUndoSteps` defaults to `0`, so the built-in undo manager exists on every `Doc`, but it stays inert unless the app enables it:

```ts
const doc = new Doc({
  type: "root",
  extensions: [MyExtension],
  undoManager: { maxUndoSteps: 100 },
});
```

This gives bindings like `@docukit/docnode-lexical` a stable one-to-one relationship: a `Doc` has exactly one undo manager. That removes the need for each binding to create, memoize, pass around, or cache its own manager.

## Skipping Undo

This PR removes string-based `origin` values from DocNode transactions. DocNode only exposes the undo behavior it owns:

```ts
doc.forceCommit(callback, { skipUndo: true });
doc.applyOperations(operations, { skipUndo: true });
```

Originally I thought the undo manager could simply ignore remote origins. I decided to keep origin as a DocSync concern and keep DocNode focused on one local flag:

- `skipUndo`: whether the transaction should be excluded from undo history.

That matters because not every transaction that should be skipped is remote. For example, initializing an editor or seeding initial content is local work, but it usually should not become the first undo step.

## Force Commit Callback

This PR adds a shared `TransactionFlags` object for the cases where a caller needs explicit undo behavior.

One use case is initialization work that should be local, synchronous, and observable as a normal transaction, but should not enter undo history. For example, seeding editor content can now be expressed as:

```ts
doc.forceCommit(
  () => {
    seedInitialContent(doc);
  },
  { skipUndo: true },
);
```

This avoids overloading `origin` with undo semantics and gives initialization code a typed way to say: commit this transaction, but do not store it in the undo stack.

The `forceCommit` overload commits any pending transaction before running the callback, applies `skipUndo` only to the callback transaction, clears it after commit or abort, and rejects nested `forceCommit` callbacks so the transaction boundary stays predictable. `applyOperations` accepts the same flags as a second parameter for replayed operations.

## Lexical Integration

`@docukit/docnode-lexical` now relies on `doc.undoManager` instead of accepting an external undo manager.

That removes the `undoManager` prop from `DocNodePlugin`, removes the Lexical-side `WeakMap` cache, and lets `setupUndoManager` no-op when `doc.undoManager.isEnabled` is false. `createLexicalDocNodeConfig(config?)` replaces the previous fixed config export so Lexical docs can opt into undo through normal `DocConfig`.

## DocSync Propagation

DocSync now propagates `skipUndo` through its binding layer instead of passing string origins into DocNode.

Network operations are applied with `{ skipUndo: true }`, while same-user local broadcasts remain undoable in the receiving tab. When a local transaction explicitly sets `skipUndo`, DocSync preserves that flag across tabs so initialization or other skipped work stays out of undo history everywhere.

## API Migration

Before:

```ts
import { Doc, UndoManager } from "@docukit/docnode";

const doc = new Doc({ type: "root", extensions: [MyExtension] });
const undoManager = new UndoManager(doc, { maxUndoSteps: 100 });

undoManager.undo();
```

After:

```ts
import { Doc } from "@docukit/docnode";

const doc = new Doc({
  type: "root",
  extensions: [MyExtension],
  undoManager: { maxUndoSteps: 100 },
});

doc.undoManager.undo();
```

Before:

```ts
doc.applyOperations(operations, "remote");
```

After:

```ts
doc.applyOperations(operations, { skipUndo: true });
```

For local initialization that should not enter undo history:

```ts
doc.forceCommit(
  () => {
    seedInitialContent(doc);
  },
  { skipUndo: true },
);
```

## Notes

- Undo remains opt-in at runtime because `maxUndoSteps` defaults to `0`.
- The API is intentionally more integrated than before because that gives `docnode-lexical` and other bindings a simpler one-to-one relationship: a `Doc` has exactly one undo manager.
- DocSync owns change origins. DocNode only receives `skipUndo` when a transaction should stay out of undo history.
