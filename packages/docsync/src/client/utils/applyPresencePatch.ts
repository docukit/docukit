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
  const newPresence = { ...cacheEntry.presence };
  for (const [key, value] of Object.entries(patch)) {
    if (key === clientId) continue; // never store own presence in cache
    if (value === undefined || value === null) {
      delete newPresence[key];
    } else {
      newPresence[key] = value;
    }
  }
  cacheEntry.presence = newPresence;
  cacheEntry.presenceListeners.forEach((listener) =>
    listener(cacheEntry.presence),
  );
}
