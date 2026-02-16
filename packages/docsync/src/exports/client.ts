export { createDocBinding } from "../bindings/index.js";
export { DocSyncClient } from "../client/index.js";
export { IndexedDBProvider } from "../client/providers/indexeddb.js";
export type { DocBinding, Presence } from "../shared/types.js";
export type {
  ChangeEvent,
  ClientEventMap,
  ClientEventName,
  DisconnectEvent,
  DocLoadEvent,
  DocUnloadEvent,
  SyncEvent,
} from "../client/utils/events.js";
export type {
  ClientConfig,
  ClientProvider,
  GetDocArgs,
  DocData,
  Identity,
  QueryResult,
} from "../client/types.js";
