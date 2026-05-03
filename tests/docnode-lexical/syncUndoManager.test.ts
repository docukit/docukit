import { describe, expect, it } from "vitest";
import { type Doc } from "@docukit/docnode";
import {
  createLexicalDoc,
  LexicalDocNode,
  _INTERNAL_syncUndoManager as syncUndoManager,
} from "@docukit/docnode-lexical";
import { createEditor, UNDO_COMMAND } from "lexical";

declare const gc: () => void;

if (typeof gc !== "function") {
  throw new Error(
    "Tests in this file require Node started with --expose-gc to validate " +
      "GC behavior. Check vitest.config.ts.",
  );
}

const makeEditor = () =>
  createEditor({
    namespace: "test",
    onError: (e: Error) => {
      throw e;
    },
  });

const listenerCount = (doc: Doc): number => doc["_changeListeners"].size;

const forceGc = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("syncUndoManager default cache (WeakMap)", () => {
  it("reuses the cached default across remounts on the same Doc, preserving history without leaking listeners", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    expect(listenerCount(doc)).toBe(0);

    const off1 = syncUndoManager(editor, doc);
    // +1 from the default UndoManager constructor, +1 from CAN_UNDO/REDO dispatcher.
    expect(listenerCount(doc)).toBe(2);

    // Record a change so the cached UndoManager has something to undo.
    doc.root.append(doc.createNode(LexicalDocNode));
    doc.forceCommit();
    expect(doc.root.first).toBeDefined();

    off1();
    // The CAN_* dispatcher is gone; the cached UndoManager's listener stays
    // (so the next mount finds the same instance and same history).
    expect(listenerCount(doc)).toBe(1);

    const off2 = syncUndoManager(editor, doc);
    // Cache hit: only the CAN_* dispatcher is added. If the cache failed, we'd
    // see 3 listeners (a second UndoManager would have registered a duplicate).
    expect(listenerCount(doc)).toBe(2);

    // The history survived the remount → UNDO_COMMAND reverts the doc change
    // through the cached UndoManager.
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(doc.root.first).toBeUndefined();

    off2();
  });

  it("default UndoManager is GC'd once its Doc becomes unreferenced (WeakMap key is weak)", async () => {
    let weakRef!: WeakRef<object>;

    // IIFE so all local refs (doc, editor, listener array) drop after the scope.
    (() => {
      const doc = createLexicalDoc();
      const editor = makeEditor();
      const off = syncUndoManager(editor, doc);

      // Snapshot the listener closure registered by the default UndoManager's
      // constructor. It's the first listener in `_changeListeners` because
      // syncUndoManager evaluates `getDefaultUndoManager(doc)` (which calls
      // `new UndoManager(doc)` → registers its listener) before registering
      // the CAN_*_COMMAND dispatcher. The closure captures `this` (the
      // UndoManager), so its collection implies the UndoManager's collection.
      const listeners = Array.from(doc["_changeListeners"]);
      weakRef = new WeakRef(listeners[0]!);

      off();
      // Note: we deliberately do NOT call doc.dispose(). The WeakMap key is
      // the doc itself, so once doc has no strong refs the entry is released
      // and the UndoManager becomes collectible — without any explicit cleanup.
    })();

    await forceGc();

    expect(weakRef.deref()).toBeUndefined();
  });
});
