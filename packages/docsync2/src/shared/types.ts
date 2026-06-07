import type { DeleteDocHandler } from "../server/handlers/deleteDoc.js";
import type { PresenceHandler } from "../server/handlers/presence.js";
import type { SyncHandler } from "../server/handlers/sync.js";
import type { UnsubscribeDocHandler } from "../server/handlers/unsubscribe.js";

export type MaybePromise<T> = T | Promise<T>;

export type TransactionFlags = { skipUndo?: boolean };

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

export type DocBinding<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> = {
  create(type: string, id: string): { doc: D; docId: string };
  deserialize(serializedDoc: S): D;
  serialize(doc: D): S;
  onChange(
    doc: D,
    cb: (ev: { operations: O; flags?: TransactionFlags }) => void,
  ): void | (() => void);
  applyOperations(doc: D, operations: O, flags?: TransactionFlags): void;
  // dispose(doc: D): void;
  // In this DocSync rewrite we have not found evidence that this is needed yet.
  // Once TanStack removes docs from query data, no strong references remain and
  // docs can be garbage-collected. GC.test.ts was added to detect possible regression.
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
