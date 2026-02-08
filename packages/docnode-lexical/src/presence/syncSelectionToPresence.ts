import { $getNodeByKey, $getSelection, $isRangeSelection } from "lexical";
import type { KeyBinding, PresenceSelection } from "../types.js";

/**
 * Reads the current editor selection, maps it to DocNode IDs, and sends it to
 * the presence channel so other clients can show this user's cursor.
 */
export function syncSelectionToPresence(
  keyBinding: KeyBinding,
  setPresence: (selection: PresenceSelection | undefined) => void,
): void {
  const selection = $getSelection();

  if (!$isRangeSelection(selection)) {
    // TODO: handle node selection
    setPresence(undefined);
    return;
  }

  const { anchor, focus } = selection;

  // Ensure nodes exist
  const anchorNode = $getNodeByKey(anchor.key);
  const focusNode = $getNodeByKey(focus.key);

  if (!anchorNode || !focusNode) {
    setPresence(undefined);
    return;
  }

  // Convert Lexical keys to DocNode IDs for cross-client compatibility
  const anchorDocNodeId = keyBinding.lexicalKeyToDocNodeId.get(anchor.key);
  const focusDocNodeId = keyBinding.lexicalKeyToDocNodeId.get(focus.key);

  if (!anchorDocNodeId || !focusDocNodeId) {
    // Node not yet mapped (e.g., newly created), skip
    setPresence(undefined);
    return;
  }

  setPresence({
    anchor: { key: anchorDocNodeId, offset: anchor.offset },
    focus: { key: focusDocNodeId, offset: focus.offset },
  });
}
