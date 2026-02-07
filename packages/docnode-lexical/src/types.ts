/** Key mapping between Lexical keys and DocNode IDs */
export type KeyBinding = {
  lexicalKeyToDocNodeId: Map<string, string>;
  docNodeIdToLexicalKey: Map<string, string>;
};

/** Selection data (DocNode IDs). Optional name/color when enriched for presence. */
export type PresenceSelection = {
  anchor: { key: string; offset: number };
  focus: { key: string; offset: number };
  name?: string;
  color?: string;
};

/**
 * Optional presence options for syncLexicalWithDoc.
 * Pass as third argument when you want to sync selection to presence and/or render remote cursors.
 */
export type syncLexicalWithDocPresenceOptions = {
  /** When provided, local selection is synced to presence and remote cursors can be rendered. */
  setPresence?:
    | ((selection: PresenceSelection | undefined) => void)
    | undefined;
  /** When provided, outgoing presence is enriched with name and color. */
  user?: { name: string; color: string } | undefined;
};
