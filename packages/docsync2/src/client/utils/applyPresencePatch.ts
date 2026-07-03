import * as v from "valibot";
import type { Presence } from "../../shared/types.js";
import { presenceSchema } from "../../shared/validators/socketProtocol.js";

const getCachedPresence = (value: unknown): Presence => {
  const parsed = v.safeParse(presenceSchema, value);
  if (parsed.success) return parsed.output;

  return {};
};

export const applyPresencePatch = (
  clientId: string,
  currentPresence: unknown,
  patch: Presence,
) => {
  let nextPresence = getCachedPresence(currentPresence);
  let changed = false;

  for (const [key, value] of Object.entries(patch)) {
    if (key === clientId) continue;

    if (value === null || value === undefined) {
      if (!(key in nextPresence)) continue;
      if (!changed) {
        nextPresence = { ...nextPresence };
        changed = true;
      }
      delete nextPresence[key];
      continue;
    }

    if (nextPresence[key] === value) continue;
    if (!changed) {
      nextPresence = { ...nextPresence };
      changed = true;
    }
    nextPresence[key] = value;
  }

  return changed ? nextPresence : undefined;
};
