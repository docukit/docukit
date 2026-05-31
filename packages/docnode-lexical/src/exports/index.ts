export { syncLexicalWithDoc } from "../index.js";
export { SKIP_UNDO_TAG } from "../constants.js";
export {
  LexicalDocNode,
  createLexicalDocNodeConfig,
} from "../lexicalDocNode.js";
export { syncPresence, updatePresence } from "../presence/index.js";
// Accepted internal-test exception: See AGENTS.md
export { setupUndoManager as _INTERNAL_setupUndoManager } from "../setupUndoManager.js";
export type {
  syncLexicalWithDocPresenceOptions,
  KeyBinding,
  PresenceUser,
  PresenceSelection,
} from "../types.js";
export type {
  Presence,
  PresenceHandle,
  LexicalPresence,
} from "../presence/types.js";
