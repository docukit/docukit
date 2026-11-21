import type { Doc } from "../main.js";
import {
  compactOperations,
  type DraftOperations,
  type Operations,
} from "../operations.js";
import type { TransactionFlags } from "../types.js";
import { decodeOperations } from "../wire.js";

/**
 * Applies a batch made here, like an undo, as `doc.applyOperations` does
 * (`apply`): `prepare` makes its node ids current. An undo of a text delete
 * brings the same letters back (see `TextStore.prepareUndo`).
 */
export function applyLocal(
  apply: Doc["applyOperations"],
  operations: Operations,
  flags: TransactionFlags | undefined,
  prepare: (draft: DraftOperations) => DraftOperations,
) {
  if (operations.length < 2) return apply(operations, flags);
  return apply(compactOperations(prepare(decodeOperations(operations))), flags);
}
