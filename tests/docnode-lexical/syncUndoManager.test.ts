import { describe, expect, it, vi } from "vitest";
import { type Doc, UndoManager } from "@docukit/docnode";
import {
  createLexicalDoc,
  LexicalDocNode,
  _INTERNAL_syncUndoManager as syncUndoManager,
} from "@docukit/docnode-lexical";
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  createEditor,
  UNDO_COMMAND,
} from "lexical";

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

  it("dispatches CAN_*_COMMAND only on transitions, plus an initial dispatch", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();

    type Dispatch = { kind: "undo" | "redo"; value: boolean };
    const dispatches: Dispatch[] = [];
    const offCanUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      (v) => {
        dispatches.push({ kind: "undo", value: v });
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const offCanRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      (v) => {
        dispatches.push({ kind: "redo", value: v });
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    const off = syncUndoManager(editor, doc);
    // Initial dispatch: both fire because previous values were undefined.
    expect(dispatches).toStrictEqual([
      { kind: "undo", value: false },
      { kind: "redo", value: false },
    ]);
    dispatches.length = 0;

    // First change: canUndo transitions false → true. canRedo stays false.
    doc.root.append(doc.createNode(LexicalDocNode));
    doc.forceCommit();
    expect(dispatches).toStrictEqual([{ kind: "undo", value: true }]);
    dispatches.length = 0;

    // Second change: canUndo and canRedo both unchanged → no dispatch.
    doc.root.append(doc.createNode(LexicalDocNode));
    doc.forceCommit();
    expect(dispatches).toStrictEqual([]);

    // Undo: canUndo stays true (still 1 entry), canRedo transitions false → true.
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(dispatches).toStrictEqual([{ kind: "redo", value: true }]);
    dispatches.length = 0;

    // Undo again: canUndo transitions true → false, canRedo stays true.
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(dispatches).toStrictEqual([{ kind: "undo", value: false }]);

    off();
    offCanUndo();
    offCanRedo();
  });

  it("with a user-provided UndoManager: bypasses the cache, owns its lifecycle", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const userUm = new UndoManager(doc);
    const baseline = listenerCount(doc); // 1, from userUm's own constructor

    const off = syncUndoManager(editor, doc, userUm);
    // +1 for the CAN_* dispatcher only — no default UndoManager is created.
    expect(listenerCount(doc)).toBe(baseline + 1);

    // Undo flows through the user's UndoManager.
    doc.root.append(doc.createNode(LexicalDocNode));
    doc.forceCommit();
    expect(userUm.canUndo()).toBe(true);

    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(userUm.canUndo()).toBe(false);
    expect(doc.root.first).toBeUndefined();

    off();
    // Binding cleanup MUST NOT detach the user's UndoManager — it has no
    // detach() and its listener lives until `doc.dispose()`. Asserting that
    // baseline is preserved (and not lower) protects against an accidental
    // "if (ownsUndoManager) undoManager.detach()" leaking into the binding.
    expect(listenerCount(doc)).toBe(baseline);
  });

  it("warns (dev-only) when HistoryPlugin's UNDO_COMMAND handler is detected at COMMAND_PRIORITY_EDITOR", async () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Simulate <HistoryPlugin /> registering at COMMAND_PRIORITY_EDITOR.
    const offHistoryStub = editor.registerCommand(
      UNDO_COMMAND,
      () => true,
      COMMAND_PRIORITY_EDITOR,
    );

    const off = syncUndoManager(editor, doc);

    // The check is deferred via queueMicrotask so sibling effects can register
    // first. Flush the microtask queue.
    await Promise.resolve();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("HistoryPlugin");

    off();
    offHistoryStub();
    warn.mockRestore();
  });

  it("does not warn when no HistoryPlugin-equivalent handler is mounted", async () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const off = syncUndoManager(editor, doc);
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();

    off();
    warn.mockRestore();
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
