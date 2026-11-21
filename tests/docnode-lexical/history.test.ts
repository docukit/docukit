import { afterEach, describe, expect, it, vi } from "vitest";
import { type Doc } from "@docukit/docnode";
import { SKIP_UNDO_TAG, syncLexicalWithDoc } from "@docukit/docnode-lexical";
import {
  $selectAt,
  $textsWithCaret,
  $typeAt,
  createLexicalDoc,
  loadedTexts,
} from "./utils.js";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  createEditor,
  type LexicalCommand,
  type LexicalEditor,
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

/** A local edit, which DocNode's undo manager records. */
const addParagraph = (editor: LexicalEditor, text: string) =>
  editor.update(
    () =>
      $getRoot().append($createParagraphNode().append($createTextNode(text))),
    { discrete: true },
  );

const listenerCount = (doc: Doc): number => doc["_changeListeners"].size;

const commandListenerCount = <T>(
  editor: LexicalEditor,
  command: LexicalCommand<T>,
  priority: number,
): number => editor._commands.get(command)?.[priority]?.size ?? 0;

const forceGc = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("Lexical undo and redo through the document's undo manager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses doc.undoManager across remounts on the same Doc, preserving history without leaking listeners", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const initialUndoHandlerCount = commandListenerCount(
      editor,
      UNDO_COMMAND,
      COMMAND_PRIORITY_HIGH,
    );
    const initialRedoHandlerCount = commandListenerCount(
      editor,
      REDO_COMMAND,
      COMMAND_PRIORITY_HIGH,
    );
    const initialListenerCount = listenerCount(doc);

    const off1 = syncLexicalWithDoc(editor, doc);
    const boundListenerCount = listenerCount(doc);
    expect(
      commandListenerCount(editor, UNDO_COMMAND, COMMAND_PRIORITY_HIGH),
    ).toBe(initialUndoHandlerCount + 1);
    expect(
      commandListenerCount(editor, REDO_COMMAND, COMMAND_PRIORITY_HIGH),
    ).toBe(initialRedoHandlerCount + 1);

    // Record a change so doc.undoManager has something to undo.
    addParagraph(editor, "Hello");
    expect(loadedTexts(doc)).toStrictEqual(["Hello"]);

    off1();
    // The binding's listeners are gone; doc.undoManager's listener stays.
    expect(listenerCount(doc)).toBe(initialListenerCount);
    expect(
      commandListenerCount(editor, UNDO_COMMAND, COMMAND_PRIORITY_HIGH),
    ).toBe(initialUndoHandlerCount);
    expect(
      commandListenerCount(editor, REDO_COMMAND, COMMAND_PRIORITY_HIGH),
    ).toBe(initialRedoHandlerCount);

    const off2 = syncLexicalWithDoc(editor, doc);
    expect(listenerCount(doc)).toBe(boundListenerCount);

    // The history survived the remount → UNDO_COMMAND reverts the doc change
    // through doc.undoManager.
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(loadedTexts(doc)).toStrictEqual([]);

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

    const off = syncLexicalWithDoc(editor, doc);
    // Initial dispatch: both fire because previous values were undefined.
    expect(dispatches).toStrictEqual([
      { kind: "undo", value: false },
      { kind: "redo", value: false },
    ]);
    dispatches.length = 0;

    // First change: canUndo transitions false → true. canRedo stays false.
    addParagraph(editor, "a");
    expect(dispatches).toStrictEqual([{ kind: "undo", value: true }]);
    dispatches.length = 0;

    // Second change: canUndo and canRedo both unchanged → no dispatch.
    addParagraph(editor, "b");
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

    const off = syncLexicalWithDoc(editor, doc);

    expect(editor.dispatchCommand(UNDO_COMMAND, undefined)).toBe(true);
    expect(undoFallback).toHaveBeenCalledOnce();

    expect(editor.dispatchCommand(REDO_COMMAND, undefined)).toBe(true);
    expect(redoFallback).toHaveBeenCalledOnce();

    off();
    offUndoFallback();
    offRedoFallback();
  });

  it("keeps the first selection when updates merge into one undo item", () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const doc = createLexicalDoc({ mergeInterval: 500 });
    const editor = makeEditor();
    const off = syncLexicalWithDoc(editor, doc);
    const edit = (change: () => void) =>
      editor.update(change, { discrete: true });
    edit(() => {
      $getRoot().append($createParagraphNode().append($createTextNode("abc")));
      $selectAt(0, 1);
    });

    now = 1000;
    edit(() => $typeAt(0, 1, "X"));
    // Only the selection changes: it is not an edit.
    edit(() => $selectAt(0, 3));
    now = 1400;
    edit(() => $typeAt(0, 3, "Y"));
    expect(editor.getEditorState().read($textsWithCaret)).toStrictEqual([
      "aXbY|c",
    ]);

    editor.dispatchCommand(UNDO_COMMAND, undefined);
    // Where the caret was before the first of the merged edits.
    expect(editor.getEditorState().read($textsWithCaret)).toStrictEqual([
      "a|bc",
    ]);

    dateNow.mockRestore();
    off();
  });

  it("leaves out of the history the updates tagged SKIP_UNDO_TAG", () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    syncLexicalWithDoc(editor, doc);
    editor.update(
      () =>
        $getRoot().append($createParagraphNode().append($createTextNode("a"))),
      { discrete: true, tag: SKIP_UNDO_TAG },
    );
    expect(loadedTexts(doc)).toStrictEqual(["a"]);
    expect(doc.undoManager.canUndo()).toBe(false);

    addParagraph(editor, "b");
    expect(doc.undoManager.canUndo()).toBe(true);
    doc.undoManager.undo();
    doc.forceCommit();
    expect(loadedTexts(doc)).toStrictEqual(["a"]);
  });

  it("does not register undo handlers when undo manager is disabled", () => {
    const doc = createLexicalDoc({ enableUndoManager: false });
    const editor = makeEditor();
    const canUndoListener = vi.fn(() => false);
    const canRedoListener = vi.fn(() => false);
    const beforeUndoHighCount = commandListenerCount(
      editor,
      UNDO_COMMAND,
      COMMAND_PRIORITY_HIGH,
    );
    const beforeRedoHighCount = commandListenerCount(
      editor,
      REDO_COMMAND,
      COMMAND_PRIORITY_HIGH,
    );

    const offCanUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      canUndoListener,
      COMMAND_PRIORITY_LOW,
    );
    const offCanRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      canRedoListener,
      COMMAND_PRIORITY_LOW,
    );

    const off = syncLexicalWithDoc(editor, doc);

    expect(
      commandListenerCount(editor, UNDO_COMMAND, COMMAND_PRIORITY_HIGH),
    ).toBe(beforeUndoHighCount);
    expect(
      commandListenerCount(editor, REDO_COMMAND, COMMAND_PRIORITY_HIGH),
    ).toBe(beforeRedoHighCount);
    expect(canUndoListener).not.toHaveBeenCalled();
    expect(canRedoListener).not.toHaveBeenCalled();

    off();
    offCanUndo();
    offCanRedo();
  });

  it("warns when HistoryPlugin is detected and undo manager is enabled", async () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Simulate <HistoryPlugin /> registering at COMMAND_PRIORITY_EDITOR.
    const offHistoryStub = editor.registerCommand(
      UNDO_COMMAND,
      () => true,
      COMMAND_PRIORITY_EDITOR,
    );

    const off = syncLexicalWithDoc(editor, doc);

    // The check is deferred via queueMicrotask so sibling effects can register
    // first. Flush the microtask queue.
    await Promise.resolve();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("HistoryPlugin");

    off();
    offHistoryStub();
    warn.mockRestore();
  });

  it("warns when HistoryPlugin is detected and undo manager is disabled", async () => {
    const doc = createLexicalDoc({ enableUndoManager: false });
    const editor = makeEditor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Simulate <HistoryPlugin /> registering at COMMAND_PRIORITY_EDITOR.
    const offHistoryStub = editor.registerCommand(
      UNDO_COMMAND,
      () => true,
      COMMAND_PRIORITY_EDITOR,
    );

    const off = syncLexicalWithDoc(editor, doc);

    // The check is deferred via queueMicrotask so sibling effects can register
    // first. Flush the microtask queue.
    await Promise.resolve();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("HistoryPlugin");

    off();
    offHistoryStub();
    warn.mockRestore();
  });

  it("does not warn when no HistoryPlugin-equivalent handler is mounted and undo manager is enabled", async () => {
    const doc = createLexicalDoc();
    const editor = makeEditor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const off = syncLexicalWithDoc(editor, doc);
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();

    off();
    warn.mockRestore();
  });

  it("does not warn when no HistoryPlugin-equivalent handler is mounted and undo manager is disabled", async () => {
    const doc = createLexicalDoc({ enableUndoManager: false });
    const editor = makeEditor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const off = syncLexicalWithDoc(editor, doc);
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
      const off = syncLexicalWithDoc(editor, doc);

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
