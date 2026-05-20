export { syncLexicalWithDoc } from "../index.js";
export {
  LexicalDocNode,
  lexicalDocNodeConfig,
  createLexicalDoc,
} from "../lexicalDocNode.js";
export { syncPresence, updatePresence } from "../presence/index.js";
// Accepted internal-test exception: See AGENTS.md
export { setupUndoManager as _INTERNAL_setupUndoManager } from "../setupUndoManager.js";
export type {
  syncLexicalWithDocPresenceOptions,
  KeyBinding,
  PresenceSelection,
} from "../types.js";
export type {
  Presence,
  PresenceHandle,
  LexicalPresence,
} from "../presence/types.js";
