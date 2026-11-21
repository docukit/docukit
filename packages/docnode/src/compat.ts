import type { Operations, OrderedOperation, StatePatch } from "./operations.js";
import { encodeOperations } from "./wire.js";

/**
 * A batch of operations as `@docukit/docnode` 0.4 and earlier wrote it:
 * `[orderedOperations, statePatch]`, every node by its whole id and every
 * state value as JSON text.
 */
export type LegacyOperations = readonly [
  orderedOperations: readonly OrderedOperation[],
  statePatch: StatePatch,
];

/**
 * Whether a batch is in the format of 0.4 and earlier: it starts with its
 * list of operations, where today's starts with its head, a string or a list
 * of strings.
 */
const isLegacy = (
  operations: Operations | LegacyOperations,
): operations is LegacyOperations =>
  typeof operations[0] !== "string" && typeof operations[0][0] !== "string";

/**
 * A batch of operations stored or sent by `@docukit/docnode` 0.4 and earlier,
 * in today's format, which `applyOperations` reads. The batch applies the
 * same way. A batch already in today's format is returned as it is.
 */
export const upgradeOperations = (operations: Operations | LegacyOperations) =>
  isLegacy(operations)
    ? encodeOperations(operations[0], operations[1])
    : operations;
