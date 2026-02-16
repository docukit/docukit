import type { Presence } from "./types.js";

/**
 * Merges a presence patch into a current presence object.
 * - Keys with value `null` or `undefined` are removed.
 * - Other keys are set on the result.
 * - Optionally skip a key (e.g. client's own id so it is not stored in cache).
 * Returns a new object; does not mutate `current`.
 */
export function mergePresencePatch(
  current: Presence,
  patch: Record<string, unknown>,
  options?: { skipKey?: string },
): Presence {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (options?.skipKey !== undefined && key === options.skipKey) continue;
    if (value === undefined || value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}
