import type { LexicalEditor, NodeKey } from "lexical";
import type { KeyBinding, PresenceSelection } from "../types.js";

/** Presence data for a remote user (required name/color for rendering). */
export type LexicalPresence = PresenceSelection & {
  name: string;
  color: string;
};

/** Map of socket IDs to their presence data (excludes the current user) */
export type Presence = Record<string, LexicalPresence>;

export type PresenceHandle = {
  /** Call this function when presence changes to update remote cursors */
  updateRemoteCursors: (presence: Presence) => void;
  /** Call this to clean up all listeners and DOM elements */
  cleanup: () => void;
};

// Internal types for cursor rendering and sync (used by presence module only)
export type CursorSelection = {
  anchor: { key: NodeKey; offset: number };
  focus: { key: NodeKey; offset: number };
  caret: HTMLElement;
  color: string;
  name: HTMLSpanElement;
  selections: HTMLElement[];
};

export type Cursor = {
  color: string;
  name: string;
  selection: CursorSelection | undefined;
};

export type PresenceBinding = {
  editor: LexicalEditor;
  cursorsContainer: HTMLElement | undefined;
  cursors: Map<string, Cursor>;
  keyBinding: KeyBinding;
};
