import type { Presence } from "../../shared/types.js";

/**
 * Applies a presence patch to a cache entry: merges patch into presence,
 * skips own clientId, notifies presence listeners.
 * Used by server-initiated presence, setPresence, and BCHelper.
 */
export function applyPresencePatch(
  clientId: string,
  cacheEntry: {
    presence: Presence;
    presenceListeners: Set<(presence: Presence) => void>;
  },
  patch: Record<string, unknown>,
): void {
  let newPresence = cacheEntry.presence;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === clientId) continue; // never store own presence in cache
    if (value === undefined || value === null) {
      if (!(key in newPresence)) continue;
      if (!changed) {
        newPresence = { ...newPresence };
        changed = true;
      }
      delete newPresence[key];
    } else {
      if (newPresence[key] === value) continue;
      if (!changed) {
        newPresence = { ...newPresence };
        changed = true;
      }
      newPresence[key] = value;
    }
  }

  if (!changed) return;

  cacheEntry.presence = newPresence;
  cacheEntry.presenceListeners.forEach((listener) =>
    listener(cacheEntry.presence),
  );
}
