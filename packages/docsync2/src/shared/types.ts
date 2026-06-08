import type { DeleteDocHandler } from "../server/handlers/deleteDoc.js";
import type { PresenceHandler } from "../server/handlers/presence.js";
import type { SyncHandler } from "../server/handlers/sync.js";
import type { UnsubscribeDocHandler } from "../server/handlers/unsubscribe.js";

export type MaybePromise<T> = T | Promise<T>;

export type Presence<T = unknown> = Record<string, T>;

export type Result<D, E = Error> =
  | { data: D; error?: never }
  | { data?: never; error: E };

export type SyncRequest<O = unknown> = {
  type: string;
  docId: string;
  operations?: O[];
  clock: number;
};

export type SyncResponse<S = unknown, O = unknown> = Result<
  { docId: string; operations?: O[]; serializedDoc?: S; clock: number },
  {
    type: "AuthorizationError" | "DatabaseError" | "ValidationError";
    message: string;
  }
>;

export type PresenceRequest = { docId: string; presence: unknown };
export type PresenceResponse = Result<
  void,
  { type: "AuthorizationError"; message: string }
>;

export type DeleteDocRequest = { docId: string };
export type DeleteDocResponse = { success: boolean };

export type UnsubscribeDocRequest = { docId: string };
export type UnsubscribeDocResponse = { success: boolean };

export type DocSyncEventName =
  | "sync"
  | "presence"
  | "delete-doc"
  | "unsubscribe-doc";

export type SerializedDocPayload<S extends object = object> = {
  serializedDoc: S;
  docId: string;
  clock: number;
};

export type ClientToServerEvents<S extends object, O extends object> = {
  sync: SyncHandler<S, O>;
  presence: PresenceHandler;
  "delete-doc": DeleteDocHandler;
  "unsubscribe-doc": UnsubscribeDocHandler;
};

export type ServerToClientEvents = {
  dirty: (payload: { docId: string }) => void;
  collaboration: (payload: {
    docId: string;
    hasCollaborators: boolean;
  }) => void;
  presence: (payload: { docId: string; presence: Presence }) => void;
};
