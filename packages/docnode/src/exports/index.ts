export { Doc, DocNode } from "../main.js";
export {
  type Json,
  type JsonDoc,
  type DocConfig,
  type StateDefinition,
  type NodeDefinition,
  type StateRecord,
  type DeepImmutable,
  type Diff,
  type JsonDocNode,
  type DefaultStateMethods,
  type Extension,
  type ChangeEvent,
  type TransactionFlags,
  type NodeIdGenerator,
  type UndoManagerConfig,
} from "../types.js";
export { defineNode } from "../utils.js";
export { boolean, number, string, defineState } from "../stateDefinitions.js";
export {
  mergeOperations,
  type Operations,
  type OperationsRow,
} from "../operations.js";
export { _INTERNAL_decodeOperations } from "../wire.js";
export type { UndoHistory } from "../undoManager.js";
