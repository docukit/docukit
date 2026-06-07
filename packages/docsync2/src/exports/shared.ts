export { createDocBinding } from "../bindings/index.js";
export {
  docValueSchema,
  existingGetDocDataSchema,
  getDocDataSchema,
  isExistingGetDocData,
  isGetDocData,
} from "../shared/validators/getDocData.js";
export {
  getDocKeySchema,
  isGetDocKey,
} from "../shared/validators/getDocKey.js";
export {
  isPresenceQueryKey,
  presenceQueryKeySchema,
} from "../shared/validators/presenceQueryKey.js";
export type {
  DocBinding,
  MaybePromise,
  Presence,
  SerializedDocPayload,
  TransactionFlags,
} from "../shared/types.js";
export type {
  ExistingGetDocData,
  GetDocData,
} from "../shared/validators/getDocData.js";
export type { GetDocKey } from "../shared/validators/getDocKey.js";
export type { PresenceQueryKey } from "../shared/validators/presenceQueryKey.js";
