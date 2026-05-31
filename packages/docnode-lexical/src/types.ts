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

/** User information attached to local presence. Missing fields use library defaults. */
export type PresenceUser = {
  name?: string | undefined;
  color?: string | undefined;
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
  /** Outgoing presence user info. Missing name falls back to "Anonymous"; missing color uses the name or a random curated color. */
  user?: PresenceUser | undefined;
};
