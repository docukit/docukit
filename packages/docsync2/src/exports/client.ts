export { DocSync2Client } from "../client/index.js";
export { docQuery } from "../client/queries/doc.js";
export { docPresence } from "../client/queries/presence.js";
export { createDoc } from "../client/mutations/createDoc.js";
export { setDocPresence } from "../client/mutations/setDocPresence.js";
export { indexedDBProvider } from "../client/providers/indexeddb.js";
export { createDocBinding } from "../bindings/index.js";
export type {
  DocQueryData,
  ExistingDocQueryData,
  DocQueryKey,
  Presence,
  PresenceQueryKey,
  DocBinding,
  MaybePromise,
  TransactionFlags,
} from "../shared/types.js";
export type { DocSync2ClientConfig } from "../client/index.js";
export type { DocQueryArgs, DocQueryOptions } from "../client/queries/doc.js";
export type {
  DocPresenceArgs,
  DocPresenceOptions,
} from "../client/queries/presence.js";
export type { CreateDocArgs } from "../client/mutations/createDoc.js";
export type { SetDocPresenceArgs } from "../client/mutations/setDocPresence.js";
export type { Identity } from "../client/providers/indexeddb.js";
