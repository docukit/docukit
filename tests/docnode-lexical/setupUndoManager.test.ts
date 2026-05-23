import { describe, expect, it, vi } from "vitest";
import { type Doc } from "@docukit/docnode";
import {
  LexicalDocNode,
  _INTERNAL_setupUndoManager as setupUndoManager,
} from "@docukit/docnode-lexical";
import { createLexicalDoc } from "./utils.js";
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  createEditor,
  REDO_COMMAND,
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

// Empty keyBinding — these tests don't exercise selection capture/restore,
// so the empty maps are fine. (The selection round-trip is exercised by
// the E2E test in tests/docsync/ui/editor/.)
const emptyKeyBinding = () => ({
  lexicalKeyToDocNodeId: new Map<string, string>(),
  docNodeIdToLexicalKey: new Map<string, string>(),
});

const listenerCount = (doc: Doc): number => doc["_changeListeners"].size;

const forceGc = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("setupUndoManager doc undo manager", () => {
  it("reuses doc.undoManager across remounts on the same Doc, preserving history without leaking listeners", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    expect(listenerCount(doc)).toBe(1);

    const off1 = setupUndoManager(editor, doc, emptyKeyBinding());
    // +1 from the built-in undo manager, +1 from CAN_UNDO/REDO dispatcher.
    expect(listenerCount(doc)).toBe(2);

    // Record a change so doc.undoManager has something to undo.
    doc.root.append(doc.createNode(LexicalDocNode));
    doc.forceCommit();
    expect(doc.root.first).toBeDefined();

    off1();
    // The CAN_* dispatcher is gone; doc.undoManager's listener stays.
    expect(listenerCount(doc)).toBe(1);

    const off2 = setupUndoManager(editor, doc, emptyKeyBinding());
    // Only the CAN_* dispatcher is added.
    expect(listenerCount(doc)).toBe(2);

    // The history survived the remount → UNDO_COMMAND reverts the doc change
    // through doc.undoManager.
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

    const off = setupUndoManager(editor, doc, emptyKeyBinding());
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

  it("does not consume undo/redo commands when there is no history entry", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const undoFallback = vi.fn(() => true);
    const redoFallback = vi.fn(() => true);

    const offUndoFallback = editor.registerCommand(
      UNDO_COMMAND,
      undoFallback,
      COMMAND_PRIORITY_LOW,
    );
    const offRedoFallback = editor.registerCommand(
      REDO_COMMAND,
      redoFallback,
      COMMAND_PRIORITY_LOW,
    );

    const off = setupUndoManager(editor, doc, emptyKeyBinding());

    expect(editor.dispatchCommand(UNDO_COMMAND, undefined)).toBe(true);
    expect(undoFallback).toHaveBeenCalledOnce();

    expect(editor.dispatchCommand(REDO_COMMAND, undefined)).toBe(true);
    expect(redoFallback).toHaveBeenCalledOnce();

    off();
    offUndoFallback();
    offRedoFallback();
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

    const off = setupUndoManager(editor, doc, emptyKeyBinding());

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

    const off = setupUndoManager(editor, doc, emptyKeyBinding());
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();

    off();
    warn.mockRestore();
  });

  it("doc.undoManager listener is GC'd once its Doc becomes unreferenced", async () => {
    let weakRef!: WeakRef<object>;

    // IIFE so all local refs (doc, editor, listener array) drop after the scope.
    (() => {
      const doc = createLexicalDoc();
      const editor = makeEditor();
      const off = setupUndoManager(editor, doc, emptyKeyBinding());

      // Snapshot the listener closure registered by doc.undoManager.
      const listeners = Array.from(doc["_changeListeners"]);
      weakRef = new WeakRef(listeners[0]!);

      off();
      // Note: we deliberately do NOT call doc.dispose(). Once doc has no
      // strong refs, the built-in undo manager listener is collectible too.
    })();

    await forceGc();

    expect(weakRef.deref()).toBeUndefined();
  });
});
