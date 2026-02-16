export { createDocBinding } from "../bindings/index.js";
export { DocSyncClient } from "../client/index.js";
export { IndexedDBProvider } from "../client/providers/indexeddb.js";
export type { DocBinding, Presence } from "../shared/types.js";
export type {
  ClientConfig,
  ClientProvider,
  DisconnectEvent,
  ChangeEvent,
  SyncEvent,
  DocLoadEvent,
  DocUnloadEvent,
  GetDocArgs,
  DocData,
  Identity,
  QueryResult,
} from "../client/types.js";
