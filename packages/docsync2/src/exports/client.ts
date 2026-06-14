export { DocSyncClient } from "../client/index.js";
export {
  getDocArgsFromKey,
  getDocKey,
} from "../client/queries/getDoc/getDocKey.js";
export { getDocPresenceKey } from "../client/queries/getDocPresence/getDocPresence.js";
export { indexedDBProvider } from "../client/providers/indexeddb.js";
export { createDocBinding } from "../client/bindings/index.js";
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
  MaybePromise,
  Presence,
  SerializedDocPayload,
} from "../shared/types.js";
export type { DocBinding, TransactionFlags } from "../client/bindings/types.js";
export type {
  ExistingGetDocData,
  GetDocData,
} from "../shared/validators/getDocData.js";
export type { GetDocKey } from "../shared/validators/getDocKey.js";
export type { PresenceQueryKey } from "../shared/validators/presenceQueryKey.js";
export type {
  ClientConfig,
  ClientProvider,
  ClientProviderContext,
  Identity,
} from "../client/types.js";
export type {
  ClientEventEmitter,
  ClientEventMap,
  ClientEventName,
} from "../client/utils/events.js";
export type {
  GetDocArgs,
  GetDocOptions,
} from "../client/queries/getDoc/getDoc.js";
export type { GetDocKeyArgs } from "../client/queries/getDoc/getDocKey.js";
export type { CreateDocArgs } from "../client/mutations/createDoc.js";
export type { SetDocPresenceArgs } from "../client/mutations/setDocPresence.js";
