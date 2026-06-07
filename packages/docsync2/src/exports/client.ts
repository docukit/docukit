export { DocSync2Client } from "../client/index.js";
export {
  getDocArgsFromKey,
  getDocKey,
} from "../client/queries/getDoc/getDocKey.js";
export { indexedDBProvider } from "../client/providers/indexeddb.js";
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
  NonNullableValue,
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
export type { DocSync2ClientConfig } from "../client/index.js";
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
export type {
  DocPresenceArgs,
  DocPresenceOptions,
} from "../client/queries/presence/presence.js";
export type { CreateDocArgs } from "../client/mutations/createDoc.js";
export type { SetDocPresenceArgs } from "../client/mutations/setDocPresence.js";
