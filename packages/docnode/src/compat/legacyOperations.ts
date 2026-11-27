import type {
  Operations,
  OrderedOperation,
  StatePatch,
} from "../operations.js";
import type { Json } from "../types.js";
import { ownId, ownKey } from "../utils.js";
import { encodeOperations } from "../wire.js";

/**
 * Operations in the legacy format: `[orderedOperations, statePatch]`.
 */
export type LegacyOperations = readonly [
  orderedOperations: readonly OrderedOperation[],
  statePatch: { [id: string]: Record<string, string> },
];

const isLegacy = (
  operations: Operations | LegacyOperations,
): operations is LegacyOperations => typeof operations[0] !== "string";

/**
 * Converts operations in the legacy format (`LegacyOperations`) so that
 * `applyOperations` can apply them. Operations already in the current format
 * are returned as they are.
 */
export function upgradeOperations(
  operations: Operations | LegacyOperations,
): Operations {
  if (!isLegacy(operations)) return operations;
  const [ordered, legacyPatch] = operations;
  const patch: StatePatch = new Map();
  for (const id in legacyPatch) {
    const state: Record<string, Json> = {};
    patch.set(ownId(id), state);
    for (const key in legacyPatch[id])
      state[ownKey(key)] = JSON.parse(legacyPatch[id][key]!) as Json;
  }
  return encodeOperations([[...ordered], patch]);
}
